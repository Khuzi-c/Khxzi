


/**
 * server.js
 *
 * Single-file Node server (Express + Socket.IO + discord.js) + static frontend.
 *
 * USAGE:
 * 1) npm init -y
 * 2) npm install express axios express-session socket.io discord.js cookie-parser
 * 3) put index.html & style.css next to this file
 * 4) node server.js
 *
 * IMPORTANT:
 * - Replace CONFIG values with your real Discord App & Bot values.
 * - Ensure your Discord App Redirect URI (Discord developer portal) includes: REDIRECT_URI exactly.
 *
 * This implementation:
 * - Handles OAuth2 (code exchange) on /auth/discord/callback and sets a session cookie.
 * - Serves /me endpoint to fetch session user (used by frontend).
 * - Socket.IO relays messages from Discord ticket channel -> website user.
 * - Creating ticket: first message from user creates Discord channel in configured category.
 * - Max 3 open tickets per user enforced.
 * - Closing tickets syncs both directions.
 */

const express = require('express');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const http = require('http');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');

const CONFIG = {
  BOT_TOKEN: "MTQzNTYyNjk5MTgwNTI2ODA1MQ.GHSyyQ.g1KJQ0luiUelj1NRX5unasJ7X4GkUIBytuW_Jk",
  CLIENT_ID: "1435626991805268051",
  CLIENT_SECRET: "UOAkW4zg7mCCdR2ZE2gGaBDK836PLIIR",

  REDIRECT_URI: "http://localhost:3000/auth/discord/callback",
  GUILD_ID: "1418226394495713426",
  TICKET_CATEGORY_ID: "1435626192341569556",
  PORT: 3000


};

/* --- App & Middleware --- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: 'khxzi_demo_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set true with HTTPS
}));

// serve static frontend (index.html + style.css must be in same folder)
app.use(express.static(path.join(__dirname, '/')));

/* --- In-memory stores --- */
const ticketsByUser = {}; // userId -> [ticketId,...]
const tickets = {}; // ticketId -> { channelId, socketId, user }
const channelToTicket = {}; // channelId -> ticketId

/* --- Discord client --- */
const dclient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

dclient.on('ready', () => {
  console.log('Discord bot ready as', dclient.user?.tag);
});

dclient.on('messageCreate', async (message) => {
  // ignore bot messages
  if (!message.guild) return;
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const ticketId = channelToTicket[channelId];
  if (!ticketId) return;

  const t = tickets[ticketId];
  if (!t) return;

  // Send message to the specific socket of the user
  const sock = io.sockets.sockets.get(t.socketId);
  if (sock) {
    sock.emit('message', {
      text: message.content,
      authorName: message.author.username,
      avatar: message.author.displayAvatarURL(),
      time: Date.now()
    });
  }
});

dclient.on('channelDelete', (channel) => {
  const tid = channelToTicket[channel.id];
  if (!tid) return;
  const t = tickets[tid];
  if (!t) return;
  const sock = io.sockets.sockets.get(t.socketId);
  if (sock) sock.emit('ticket:closed', { ticketId: tid });
  // cleanup
  delete channelToTicket[channel.id];
  delete tickets[tid];
  const arr = ticketsByUser[t.user.id] || [];
  ticketsByUser[t.user.id] = arr.filter(x => x !== tid);
});

/* --- Start discord client --- */
dclient.login(CONFIG.BOT_TOKEN).catch(err => {
  console.error('Discord login failed (check BOT_TOKEN):', err.message);
});

/* --- OAuth helpers --- */
function discordAuthURL() {
  const base = 'https://discord.com/api/oauth2/authorize';
  const params = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email'
  });
  return `${base}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const url = 'https://discord.com/api/oauth2/token';
  const params = new URLSearchParams();
  params.append('client_id', CONFIG.CLIENT_ID);
  params.append('client_secret', CONFIG.CLIENT_SECRET);
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', CONFIG.REDIRECT_URI);

  const r = await axios.post(url, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return r.data;
}

async function getUserInfo(access_token) {
  const r = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
  return r.data;
}

/* --- Routes --- */

// create initial OAuth redirect
app.get('/auth/discord', (req, res) => {
  return res.redirect(discordAuthURL());
});

// OAuth callback - exchanges code and creates session
// Returns a small HTML page that posts a message to the opener and closes the popup
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenData = await exchangeCodeForToken(code);

    if (!tokenData || !tokenData.access_token) {
      console.warn('No access_token returned', tokenData);
      return res.status(500).send(`<pre>OAuth failed: ${JSON.stringify(tokenData,null,2)}</pre>`);
    }

    const userData = await getUserInfo(tokenData.access_token);

    // build avatar url if present
    const avatar = userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : '';

    // store in session
    req.session.user = {
      id: userData.id,
      username: userData.username,
      discriminator: userData.discriminator,
      email: userData.email,
      avatar
    };

    // small HTML that notifies opener and closes
    return res.send(`
      <html>
        <body>
          <script>
            try {
              window.opener.postMessage({ type: 'khxzi_oauth_success' }, location.origin);
            } catch(e){}
            window.close();
          </script>
          <div style="font-family:Inter,Arial;padding:20px">Auth successful — you can close this window.</div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    return res.status(500).send(`<pre>OAuth exchange error: ${err.message}\n${JSON.stringify(err.response?.data||{},null,2)}</pre>`);
  }
});

// return session user
app.get('/me', (req, res) => {
  if (req.session?.user) return res.json({ logged: true, user: req.session.user });
  return res.json({ logged: false });
});

// Close ticket by ticketId (user)
app.post('/close/:ticketId', async (req, res) => {
  const ticketId = req.params.ticketId;
  const t = tickets[ticketId];
  if (!t) return res.status(404).json({ ok:false, error:'not found' });

  try {
    const ch = await dclient.channels.fetch(t.channelId);
    if (ch && ch.deletable) await ch.delete('Closed by website user');
  } catch (err) {
    console.warn('Failed to delete channel:', err.message);
  }

  // notify socket
  const sock = io.sockets.sockets.get(t.socketId);
  if (sock) sock.emit('ticket:closed', { ticketId });

  // cleanup
  delete channelToTicket[t.channelId];
  delete tickets[ticketId];
  const arr = ticketsByUser[t.user.id] || [];
  ticketsByUser[t.user.id] = arr.filter(x => x !== ticketId);

  return res.json({ ok:true });
});

/* --- Socket.IO --- */
io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);

  socket.on('init', payload => {
    // payload.user should be the session user from frontend fetch /me
    socket.user = payload.user || null;
    console.log('socket init', socket.id, socket.user?.username);
  });

  socket.on('message', async (payload) => {
    if (!socket.user) return socket.emit('error_msg', 'Not authenticated. Please sign in with Discord.');
    const text = (payload.text || '').trim();
    if (!text) return;

    // Check ticket limit (max 3)
    const openArr = ticketsByUser[socket.user.id] || [];
    // If there is an existing open ticket for this socket, use it
    let foundTicketId = payload.ticketId || (openArr.length ? openArr[openArr.length - 1] : null);
    // If none, create a new ticket
    try {
      if (!foundTicketId) {
        if (openArr.length >= 3) {
          return socket.emit('error_msg', 'You have reached the maximum of 3 open tickets. Please close one first.');
        }

        // create channel in guild under category
        const guild = await dclient.guilds.fetch(CONFIG.GUILD_ID);
        // sanitize name
        const safeName = `ticket-${socket.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,80);
        const uniqueSuffix = Date.now().toString().slice(-5);
        const ch = await guild.channels.create({
          name: `${safeName}-${uniqueSuffix}`,
          type: ChannelType.GuildText,
          parent: CONFIG.TICKET_CATEGORY_ID,
          permissionOverwrites: []
        });

        const ticketId = `T${Date.now().toString(36)}`;
        tickets[ticketId] = { channelId: ch.id, socketId: socket.id, user: socket.user };
        channelToTicket[ch.id] = ticketId;
        ticketsByUser[socket.user.id] = (ticketsByUser[socket.user.id] || []).concat([ticketId]);
        foundTicketId = ticketId;

        // send branded embed with banner and buttons
        const embed = new EmbedBuilder()
          .setColor(0xC72828)
          .setAuthor({ name: "Khxzi's Dev Services", iconURL: "https://khxzi.com/assets/logo.png" })
          .setTitle("🎫 Ticket Created - Order Website")
          .setDescription(`Hello <@${socket.user.id}>!\n\nYour Order Website ticket has been created.\nPlease describe your issue in detail and a staff member will assist you shortly.`)
          .addFields(
            { name: "Ticket Information", value: `• Category: Order Website\n• Created: ${new Date().toLocaleString()}\n• User: ${socket.user.username}`, inline: false }
          )
          .setImage("https://khxzi.com/assets/banner.png")
          .setFooter({ text: "Discord Ticket System v1.0.0" })
          .setTimestamp();

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('close_by_staff').setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setLabel('Open Support Site').setURL('https://khxzi.com').setStyle(ButtonStyle.Link)
        );

        await ch.send({ content: `<@&${guild.roles.cache?.find(r=>r.name.toLowerCase().includes('admin'))?.id || ''}>`.trim(), embeds: [embed], components: [buttons] }).catch(() => ch.send({ embeds: [embed] }));

        // inform socket client about new ticket
        socket.emit('ticket:opened', { ticketId: foundTicketId, channelId: ch.id });
      }

      // send user's message to Discord channel
      const t = tickets[foundTicketId];
      if (!t) return socket.emit('error_msg', 'Ticket mapping error.');

      const channel = await dclient.channels.fetch(t.channelId);
      if (channel) {
        await channel.send(`**${socket.user.username} (website):** ${text}`);
      }

      // Frontend already shows the local message immediately so we do NOT echo it back (avoids doubling).
    } catch (err) {
      console.error('message handling error', err);
      socket.emit('error_msg', 'Server error: ' + (err.message || 'unknown'));
    }
  });

  socket.on('disconnect', () => {
    // no immediate cleanup; tickets persist so staff can continue
  });
});

/* --- Start server --- */
server.listen(CONFIG.PORT, () => {
  console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  console.log('Discord OAuth URL:', discordAuthURL());
});

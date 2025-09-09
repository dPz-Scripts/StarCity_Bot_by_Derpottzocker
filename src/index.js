import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';

/* ===========================
   VERSION & BRAND
   =========================== */
const STARSTYLE_VERSION = 'StarCity style v3';

const BRAND = {
  name: process.env.BRAND_NAME || 'StarCity || Beta-Whitelist OPEN',
  color: parseInt((process.env.BRAND_COLOR || '00A2FF').replace('#', ''), 16),
  icon: process.env.BRAND_ICON_URL || null,     // https://.../icon.png
  banner: process.env.BRAND_BANNER_URL || null, // https://.../banner.png
};

const clean = (v, fb = '—') => {
  if (v === null || v === undefined) return fb;
  const s = String(v).trim();
  return s.length ? s : fb;
};
const trunc = (s, n) => {
  s = clean(s, '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const makeCaseId = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return `#T-${out}`;
};

/* ===========================
   DISCORD CLIENT
   =========================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', async () => {
  console.log(`✅ Eingeloggt als ${client.user.tag}`);
  console.log(`🎨 ${STARSTYLE_VERSION}`);
  try {
    await registerSlashCommands();
    console.log('✅ Slash-Commands registriert');
  } catch (e) {
    console.error('❌ Slash-Command-Register-Fehler:', e);
  }
});

client.login(process.env.DISCORD_TOKEN);

/* ===========================
   SLASH COMMANDS
   =========================== */
async function registerSlashCommands() {
  const commands = [
    {
      name: 'ticket-test',
      description: 'Erstellt ein Test-Ticket (nur für dich und Staff sichtbar).',
      options: [{ name: 'charname', description: 'RP-Name der Figur', type: 3, required: true }],
    },
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = (await client.application.fetch()).id;
  await rest.put(Routes.applicationGuildCommands(appId, process.env.GUILD_ID), { body: commands });
}

/* ===========================
   PERMISSION CHECK (optional)
   =========================== */
function hasNeededPermsIn(channelOrId) {
  try {
    const perms = client.guilds.cache.get(process.env.GUILD_ID)?.members?.me?.permissionsIn(channelOrId);
    if (!perms) return { ok: false, missing: ['UNKNOWN'] };
    const need = [
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    const missing = need.filter((p) => !perms.has(p));
    return { ok: missing.length === 0, missing };
  } catch {
    return { ok: false, missing: ['UNKNOWN'] };
  }
}

/* ===========================
   TICKET-CHANNEL (StarCity Style)
   =========================== */
async function createTicketChannel({
  guildId,
  categoryId,
  staffRoleId,
  applicantDiscordId,
  applicantTag = '—',
  form = {
    charName: '',
    alter: null,
    steamHex: '',
    discordTag: '',
    howFound: '',
    deskItem: '',
    timezone: '',
    answers: [],      // [{question, answer}] ODER [{key, value}]
    websiteTicketId: null,
  },
}) {
  const guild = await client.guilds.fetch(guildId);

  // Kategorie validieren
  let parent = undefined;
  if (categoryId) {
    const cat = await guild.channels.fetch(categoryId).catch(() => null);
    if (cat && cat.type === ChannelType.GuildCategory) {
      const check = hasNeededPermsIn(cat.id);
      if (check.ok) parent = cat.id;
      else console.warn('⚠️ Mir fehlen im Kategorie-Ordner Rechte. Erstelle Ticket OHNE parent.');
    } else {
      console.warn('⚠️ TICKETS_CATEGORY_ID ist keine Kategorie. Erstelle ohne parent.');
    }
  }

  const safeName = (form.charName || 'bewerber').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 20);
  const shortId = (form.websiteTicketId || applicantDiscordId || '0000').toString().slice(-4);
  const channelName = `whitelist-${safeName}-${shortId}`;
  const caseId = makeCaseId();

  // Overwrites inkl. Bot
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (applicantDiscordId) {
    overwrites.push({ id: applicantDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent,
      permissionOverwrites: overwrites,
      reason: `Whitelist-Ticket für ${applicantTag || applicantDiscordId || 'Unbekannt'}`,
    });
  } catch (e) {
    console.error('❌ Erstellen des Channels fehlgeschlagen:', e?.code, e?.message);
    throw e;
  }

  // EMBED (StarCity)
  const embed = new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle('📨 Whitelist-Ticket eröffnet')
    .setDescription([
      '**Herzlich Willkommen auf StarCity!**',
      'Schön, dass du dich für unser Projekt interessierst.',
      'Hier ist die Zusammenfassung deiner Bewerbung:',
      '',
      '*(Unser Team meldet sich zeitnah bei dir. Bitte bleib in diesem Ticket.)*',
    ].join('\n'))
    .setFooter({ text: `${caseId} • Kategorie: Whitelist` })
    .setTimestamp();

  if (BRAND.icon) embed.setAuthor({ name: BRAND.name, iconURL: BRAND.icon }); else embed.setAuthor({ name: BRAND.name });
  if (BRAND.icon) embed.setThumbnail(BRAND.icon);
  if (BRAND.banner) embed.setImage(BRAND.banner);

  const bewerberText = applicantDiscordId
    ? `<@${applicantDiscordId}> (${clean(form.discordTag || applicantTag)})`
    : clean(form.discordTag || applicantTag);

  embed.addFields(
    { name: 'Bewerber', value: trunc(bewerberText, 256), inline: false },
    { name: 'Charakter', value: trunc(form.charName, 128) || '—', inline: true },
    { name: 'Alter', value: form.alter ? String(form.alter) : '—', inline: true },
    { name: 'Steam Hex', value: trunc(form.steamHex, 64) || '—', inline: true },
    { name: 'Discord', value: trunc(form.discordTag, 128) || '—', inline: true },
    { name: 'Zeitzone', value: trunc(form.timezone, 64) || '—', inline: true },
    { name: 'Wie gefunden', value: trunc(form.howFound, 1024) || '—', inline: false },
    { name: 'Schreibtisch-Item', value: trunc(form.deskItem, 1024) || '—', inline: false },
  );

  const qa = Array.isArray(form.answers) ? form.answers : [];
  for (let i = 0; i < qa.length && i < 12; i++) {
    const q = clean(qa[i].question || qa[i].key, `Frage ${i + 1}`);
    const a = clean(qa[i].answer || qa[i].value, '—');
    embed.addFields({ name: trunc(`Frage ${i + 1}: ${q}`, 256), value: trunc(a, 1024), inline: false });
  }

  await channel.send({
    content: `<@&${staffRoleId}> Neues Ticket`,
    embeds: [embed],
    allowedMentions: { roles: [staffRoleId] },
  });

  return { channel, caseId };
}

/* ===========================
   SLASH HANDLER (fix: nur 1x ack)
   =========================== */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'ticket-test') return;

  // **Nur EIN mal bestätigen**
  try {
    await interaction.deferReply({ flags: 64 }); // EPHEMERAL
  } catch (e) {
    console.error('❌ deferReply fehlgeschlagen:', e?.code, e?.message);
    return; // nicht nochmal reply versuchen -> sonst 40060
  }

  try {
    const charName = interaction.options.getString('charname', true);

    const { channel } = await createTicketChannel({
      guildId: process.env.GUILD_ID,
      categoryId: process.env.TICKETS_CATEGORY_ID,
      staffRoleId: process.env.STAFF_ROLE_ID,
      applicantDiscordId: interaction.user.id,
      applicantTag: `${interaction.user.username}`,
      // Demo-Felder für sofortige Vorschau
      form: {
        charName,
        alter: 19,
        steamHex: '110000112345678',
        discordTag: `${interaction.user.username}`,
        howFound: 'Über einen Freund',
        deskItem: 'Kaffee & Notizbuch',
        timezone: 'Europe/Berlin',
        websiteTicketId: 'SC-TEST-001',
        answers: [
          { question: 'Woran kannst du dich erinnern, wenn dir ein Medic geholfen hat?', answer: 'Nicht an Details der Verletzung.' },
          { question: 'Darf der FiveM-Account geteilt werden?', answer: 'Nein.' },
          { question: 'Max. Mitglieder in einer Fraktion?', answer: '10' },
        ],
      },
    });

    await interaction.editReply({ content: `✅ Ticket erstellt: https://discord.com/channels/${process.env.GUILD_ID}/${channel.id}` });
  } catch (e) {
    console.error('❌ Ticket-Fehler:', e?.code, e?.message);
    await interaction.editReply({
      content:
        '❌ Konnte Ticket nicht erstellen. Prüfe Rechte & IDs.\n' +
        '• Hat der Bot im Kategorie-Ordner **Manage Channels** + **View Channel**?\n' +
        '• Ist `TICKETS_CATEGORY_ID` wirklich eine **Kategorie**?\n' +
        '• Stimmt `STAFF_ROLE_ID` (Server-spezifisch)?',
    });
  }
});

/* ===========================
   EXPRESS SERVER & HMAC
   =========================== */
const app = express();

// Sichtbar prüfen:
app.get('/health', (_req, res) => res.send('StarCity Bot alive'));
app.get('/version', (_req, res) => res.json({ version: STARSTYLE_VERSION }));

// Raw JSON (für HMAC)
app.use((req, _res, next) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    try { req.body = JSON.parse(req.rawBody.toString('utf8') || '{}'); }
    catch { req.body = {}; }
    next();
  });
});

function isValidSignature(rawBody, signatureHex, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const digest = hmac.digest('hex');
  if (!signatureHex) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

/* ===========================
   POST /whitelist
   =========================== */
app.post('/whitelist', async (req, res) => {
  try {
    const sig = req.headers['x-signature'];
    if (!isValidSignature(req.rawBody, sig, process.env.WEBHOOK_SECRET)) {
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }

    const {
      discordId,
      discordTag,
      charName,
      steamHex,
      alter,
      erfahrung,        // „Wie gefunden“
      motivation,       // „Schreibtisch-Item“
      timezone,
      websiteTicketId,
      answers,          // [{question, answer}] ODER [{key, value}]
    } = req.body;

    if (!charName) return res.status(400).json({ ok: false, error: 'charName required' });

    const { channel, caseId } = await createTicketChannel({
      guildId: process.env.GUILD_ID,
      categoryId: process.env.TICKETS_CATEGORY_ID,
      staffRoleId: process.env.STAFF_ROLE_ID,
      applicantDiscordId: discordId,
      applicantTag: discordTag,
      form: {
        charName,
        alter,
        steamHex,
        discordTag,
        howFound: erfahrung,
        deskItem: motivation,
        timezone,
        websiteTicketId,
        answers: Array.isArray(answers) ? answers : [],
      },
    });

    return res.json({
      ok: true,
      caseId,
      channelId: channel.id,
      url: `https://discord.com/channels/${process.env.GUILD_ID}/${channel.id}`,
    });
  } catch (e) {
    console.error('❌ /whitelist Fehler:', e?.code, e?.message);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/* ===========================
   START
   =========================== */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`🌐 Webhook-Server läuft auf Port ${PORT}`);
});

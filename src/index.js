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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

/* ===========================
   VERSION & BRAND
   =========================== */
const STARSTYLE_VERSION = 'StarCity style v6.4';

const BRAND = {
  name: process.env.BRAND_NAME || 'StarCity || Beta-Whitelist OPEN',
  color: parseInt((process.env.BRAND_COLOR || '00A2FF').replace('#', ''), 16),
  icon: process.env.BRAND_ICON_URL || null,
  banner: process.env.BRAND_BANNER_URL || null,
};

/* ===========================
   HELPERS
   =========================== */
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
const normalizeAnswers = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x, i) => ({
      q: clean(x?.question ?? x?.key ?? x?.id ?? `Frage ${i + 1}`),
      a: clean(x?.answer ?? x?.value ?? ''),
    }))
    .filter((x) => x.a !== '—');
};

// ---- sichere Antwort-Helfer (verhindert 50027-Crash) ----
const toPayload = (x) => (typeof x === 'string' ? { content: x } : x || { content: 'OK' });

async function safeEditReply(interaction, payload) {
  try {
    await interaction.editReply(toPayload(payload));
  } catch (e) {
    // Token abgelaufen oder ungültig -> in den Kanal schreiben statt crashen
    if (e?.code === 50027 || e?.status === 401) {
      try { await interaction.channel?.send(toPayload(payload)); } catch {}
    } else {
      throw e;
    }
  }
}

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
   GLOBAL ERROR HANDLER (crash-sicher)
   =========================== */
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason?.code, reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err?.code, err?.message || err);
});
client.on('error', (err) => console.error('CLIENT ERROR:', err?.code, err?.message || err));
client.on('shardError', (err) => console.error('SHARD ERROR:', err?.code, err?.message || err));

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
   PERMISSIONS
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
   TICKET-UTILS
   =========================== */
function buildButtonsState({ claimed = false, closed = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Annehmen').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(closed || claimed),
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Schließen').setEmoji('🔒').setStyle(ButtonStyle.Secondary).setDisabled(closed),
  );
}

async function lockChannelSend(channel, applicantId) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false }).catch(() => {});
  if (applicantId) await channel.permissionOverwrites.edit(applicantId, { SendMessages: false }).catch(() => {});
  if (!channel.name.startsWith('closed-')) await channel.setName(`closed-${channel.name}`).catch(() => {});
}

function readMeta(channel) { try { return JSON.parse(channel.topic || '{}'); } catch { return {}; } }
async function writeMeta(channel, meta) { await channel.setTopic(JSON.stringify(meta)).catch(() => {}); }

/* ===========================
   TICKET-CHANNEL (StarCity Style + Buttons)
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
    answers: [],
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
      else console.warn('⚠️ Im Kategorie-Ordner fehlen mir Rechte. Erstelle Ticket OHNE parent.');
    } else {
      console.warn('⚠️ TICKETS_CATEGORY_ID ist keine Kategorie. Erstelle ohne parent.');
    }
  }

  const safeName = (form.charName || 'bewerber').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 20);
  const shortId = (form.websiteTicketId || applicantDiscordId || '0000').toString().slice(-4);
  const channelName = `whitelist-${safeName}-${shortId}`;
  const caseId = makeCaseId();

  // Overwrites – Bot inkl. ManageChannels
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
  ];
  if (applicantDiscordId) {
    overwrites.push({ id: applicantDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  // Channel erstellen
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent,
    permissionOverwrites: overwrites,
    reason: `Whitelist-Ticket für ${applicantTag || applicantDiscordId || 'Unbekannt'}`,
  });

  // Meta vormerken
  const meta = {
    caseId,
    applicantDiscordId,
    createdAt: Date.now(),
    claimedBy: null,
    claimedAt: null,
    originalMessageId: null,
    closedBy: null,
    closedAt: null,
  };
  await writeMeta(channel, meta);

  // EMBED
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

  const bewerberText = applicantDiscordId ? `<@${applicantDiscordId}> (${clean(form.discordTag || applicantTag)})` : clean(form.discordTag || applicantTag);

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

  const qa = normalizeAnswers(form.answers);
  for (let i = 0; i < qa.length && i < 12; i++) {
    embed.addFields({ name: trunc(`Frage ${i + 1}: ${qa[i].q}`, 256), value: trunc(qa[i].a, 1024), inline: false });
  }

  // embed + buttons
  const sent = await channel.send({
    content: `<@&${process.env.STAFF_ROLE_ID}> Neues Ticket`,
    embeds: [embed],
    components: [buildButtonsState()],
    allowedMentions: { roles: [process.env.STAFF_ROLE_ID] },
  });

  meta.originalMessageId = sent.id;
  await writeMeta(channel, meta);

  return { channel, caseId, messageId: sent.id };
}

/* ===========================
   INTERACTIONS (Slash + Buttons)
   =========================== */
client.on('interactionCreate', async (interaction) => {
  // Slash
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== 'ticket-test') return;

    try { await interaction.deferReply({ flags: 64 }); } catch { return; }

    try {
      const charName = interaction.options.getString('charname', true);
      const { channel } = await createTicketChannel({
        guildId: process.env.GUILD_ID,
        categoryId: process.env.TICKETS_CATEGORY_ID,
        staffRoleId: process.env.STAFF_ROLE_ID,
        applicantDiscordId: interaction.user.id,
        applicantTag: `${interaction.user.username}`,
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
      await safeEditReply(interaction, `✅ Ticket erstellt: https://discord.com/channels/${process.env.GUILD_ID}/${channel.id}`);
    } catch (e) {
      console.error('❌ Ticket-Fehler:', e?.code, e?.message);
      await safeEditReply(interaction, '❌ Konnte Ticket nicht erstellen (Details in Logs).');
    }
    return;
  }

  // Buttons
  if (!interaction.isButton()) return;

  try {
    const staffRoleId = process.env.STAFF_ROLE_ID;
    if (!staffRoleId) { await interaction.reply({ content: '⚠️ STAFF_ROLE_ID nicht gesetzt.', flags: 64 }); return; }
    const isStaff = interaction.member.roles.cache.has(staffRoleId);
    if (!isStaff) { await interaction.reply({ content: '❌ Nur Staff darf diese Aktion nutzen.', flags: 64 }); return; }

    await interaction.deferReply({ flags: 64 });

    const channel = interaction.channel;
    const meta = readMeta(channel) || {};
    const applicantId = meta.applicantDiscordId || null;

    // Bot-Rechte
    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.ManageChannels)) {
      console.error('BTN: fehlende Rechte ManageChannels in', channel.id);
      await safeEditReply(interaction, '❌ Mir fehlt **Manage Channels** in diesem Ticket/Kategorie.');
      return;
    }

    const editButtons = async (state) => {
      try {
        if (!meta.originalMessageId) return;
        const msg = await channel.messages.fetch(meta.originalMessageId);
        await msg.edit({ components: [buildButtonsState(state)] });
      } catch (e) {
        console.error('BTN: Button-Edit-Fehler', e?.code, e?.message);
      }
    };

    if (interaction.customId === 'ticket_claim') {
      if (meta.claimedBy) { await safeEditReply(interaction, `ℹ️ Bereits übernommen von <@${meta.claimedBy}>.`); return; }
      meta.claimedBy = interaction.user.id;
      meta.claimedAt = Date.now();
      await writeMeta(channel, meta);
      await editButtons({ claimed: true, closed: false });
      await channel.send(`✅ <@${interaction.user.id}> **hat das Ticket übernommen.**`);
      await safeEditReply(interaction, 'Übernahme bestätigt.');
      return;
    }

    if (interaction.customId === 'ticket_close') {
      meta.closedBy = interaction.user.id;
      meta.closedAt = Date.now();
      await writeMeta(channel, meta);
      await lockChannelSend(channel, applicantId);
      await editButtons({ claimed: !!meta.claimedBy, closed: true });
      await channel.send(`🔒 <@${interaction.user.id}> **hat das Ticket geschlossen.**`);
      await safeEditReply(interaction, 'Ticket geschlossen.');
      return;
    }

    await safeEditReply(interaction, 'ℹ️ Unbekannte Aktion.');
  } catch (e) {
    console.error('BTN: Unhandled error', e?.code, e?.message || e);
    try { await safeEditReply(interaction, '❌ Unerwarteter Fehler bei der Aktion (Details in Logs).'); } catch {}
  }
});

/* ===========================
   EXPRESS SERVER & HMAC
   =========================== */
const app = express();

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
      discordId, discordTag, charName, steamHex, alter,
      erfahrung, howFound, motivation, deskItem,
      timezone, websiteTicketId, answers,
    } = req.body;

    if (!charName) return res.status(400).json({ ok: false, error: 'charName required' });

    const { channel, caseId } = await createTicketChannel({
      guildId: process.env.GUILD_ID,
      categoryId: process.env.TICKETS_CATEGORY_ID,
      staffRoleId: process.env.STAFF_ROLE_ID,
      applicantDiscordId: discordId,
      applicantTag: discordTag,
      form: {
        charName, alter, steamHex, discordTag,
        howFound: erfahrung ?? howFound ?? '',
        deskItem: motivation ?? deskItem ?? '',
        timezone, websiteTicketId,
        answers: normalizeAnswers(answers),
      },
    });

    return res.json({ ok: true, caseId, channelId: channel.id, url: `https://discord.com/channels/${process.env.GUILD_ID}/${channel.id}` });
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

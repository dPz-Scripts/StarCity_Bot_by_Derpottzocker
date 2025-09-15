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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

/* ===========================
   VERSION & BRANDING
   =========================== */
const STARSTYLE_VERSION = 'StarCity style v7.0 - Complete Rebuild';

const ASSET_VER = process.env.ASSET_VER || String(Math.floor(Date.now() / 1000));

const BRAND = {
  name: process.env.BRAND_NAME || 'StarCity || Beta-Whitelist OPEN',
  color: parseInt((process.env.BRAND_COLOR || '00A2FF').replace('#', ''), 16),
  icon: process.env.BRAND_ICON_URL
    ? process.env.BRAND_ICON_URL
    : (process.env.SELF_URL ? `${process.env.SELF_URL}/assets/sclogo1.png?v=${ASSET_VER}` : null),
  banner: process.env.BRAND_BANNER_URL
    ? process.env.BRAND_BANNER_URL
    : (process.env.SELF_URL ? `${process.env.SELF_URL}/assets/StarCityBanner1.jpg?v=${ASSET_VER}` : null),
};

// StarCity Server Konfiguration
const STARCITY_CONFIG = {
  guildId: '1387455434033598514',
  categoryId: '1387814432473874472',
  staffRoles: ['1387483858940727502', '1393605462242627696'],
  logChannelId: '1393651526236508270',
};

/* ===========================
   HILFSFUNKTIONEN
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

/* ===========================
   IDEMPOTENZ SYSTEM (NEU)
   =========================== */
class IdempotencyManager {
  constructor() {
    this.cache = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // 1 Minute
  }

  createKey(type, guildId, userId, charName) {
    return `${type}:${guildId}:${userId}:${charName.toLowerCase().trim()}`;
  }

  isAllowed(key) {
    const now = Date.now();
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.cache.set(key, { 
        inflight: true, 
        timestamp: now,
        attempts: 1 
      });
      return { allowed: true, reason: 'new' };
    }

    if (entry.inflight) {
      return { allowed: false, reason: 'inflight' };
    }

    const age = now - entry.timestamp;
    if (age < 60000) { // 1 Minute
      return { allowed: false, reason: 'recent', age: Math.round(age / 1000) };
    }

    entry.inflight = true;
    entry.timestamp = now;
    entry.attempts++;
    return { allowed: true, reason: 'retry' };
  }

  markComplete(key) {
    const entry = this.cache.get(key);
    if (entry) {
      entry.inflight = false;
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (!entry.inflight && now - entry.timestamp > 300000) { // 5 Minuten
        this.cache.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.cache.clear();
  }
}

const idempotency = new IdempotencyManager();

/* ===========================
   TICKET META STORAGE
   =========================== */
class TicketMetaStorage {
  constructor() {
    this.meta = new Map();
  }

  set(channelId, meta) {
    this.meta.set(channelId, meta);
  }

  get(channelId) {
    return this.meta.get(channelId) || {
      caseId: null,
      applicantDiscordId: null,
      createdAt: Date.now(),
      claimedBy: null,
      claimedAt: null,
      closedBy: null,
      closedAt: null,
      status: 'open'
    };
  }

  delete(channelId) {
    this.meta.delete(channelId);
  }
}

const ticketMetaStorage = new TicketMetaStorage();

/* ===========================
   DISCORD CLIENT
   =========================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('clientReady', async () => {
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
   GLOBALER FEHLERHANDLER
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
    {
      name: 'add',
      description: 'Fügt einen Benutzer zum aktuellen Ticket hinzu.',
      options: [{ name: 'user', description: 'Benutzer der hinzugefügt werden soll', type: 6, required: true }],
    },
    {
      name: 'remove',
      description: 'Entfernt einen Benutzer aus dem aktuellen Ticket.',
      options: [{ name: 'user', description: 'Benutzer der entfernt werden soll', type: 6, required: true }],
    },
    {
      name: 'ticket-info',
      description: 'Zeigt Informationen über das aktuelle Ticket an.',
    },
    {
      name: 'ticket-rename',
      description: 'Benennt das aktuelle Ticket um.',
      options: [{ name: 'name', description: 'Neuer Name für das Ticket', type: 3, required: true }],
    },
    {
      name: 'ticket-close',
      description: 'Schließt das aktuelle Ticket.',
    },
    {
      name: 'ticket-transcript',
      description: 'Erstellt ein Transcript des aktuellen Tickets.',
    },
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = (await client.application.fetch()).id;
  
  // ZUERST alle alten Commands löschen
  await rest.put(Routes.applicationGuildCommands(appId, STARCITY_CONFIG.guildId), { body: [] });
  console.log('🗑️ Alte Slash-Commands gelöscht');
  
  // Dann neue Commands registrieren
  await rest.put(Routes.applicationGuildCommands(appId, STARCITY_CONFIG.guildId), { body: commands });
  console.log('✅ Neue Slash-Commands registriert');
}

/* ===========================
   BERECHTIGUNGEN
   =========================== */
function hasNeededPermsIn(channelOrId) {
  try {
    const perms = client.guilds.cache.get(STARCITY_CONFIG.guildId)?.members?.me?.permissionsIn(channelOrId);
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
   TICKET-UTILITIES (NEU)
   =========================== */
function buildTicketButtons({ claimed = false, closed = false } = {}) {
  const row = new ActionRowBuilder();
  
  if (!closed) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel(claimed ? 'Übernommen' : 'Annehmen')
        .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(claimed)
        .setEmoji(claimed ? '✅' : '🎯')
    );
    
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_rename')
        .setLabel('Umbenennen')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(false)
        .setEmoji('✏️')
    );
  }
  
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel(closed ? 'Geschlossen' : 'Schließen')
      .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Danger)
      .setDisabled(closed)
      .setEmoji('🔒')
  );
  
  return row;
}

// Nachrichten robust im Ticket-Channel posten (mit Rechte-Check & Logging)
async function safeChannelSend(channel, guild, content, traceId = 'n/a') {
  try {
    const fetched = await guild.channels.fetch(channel.id).catch(() => null);
    if (!fetched) {
      console.warn(`[${traceId}] safeChannelSend: Channel nicht gefunden`);
      return { ok: false, reason: 'not_found' };
    }
    const me = guild.members.me;
    const perms = fetched.permissionsFor(me);
    const can = perms?.has(PermissionFlagsBits.ViewChannel)
      && perms?.has(PermissionFlagsBits.SendMessages)
      && perms?.has(PermissionFlagsBits.ReadMessageHistory);
    console.log(`[${traceId}] safeChannelSend: perms -> view=${perms?.has(PermissionFlagsBits.ViewChannel)} send=${perms?.has(PermissionFlagsBits.SendMessages)} history=${perms?.has(PermissionFlagsBits.ReadMessageHistory)}`);
    if (!can) {
      console.warn(`[${traceId}] safeChannelSend: Fehlende Rechte zum Senden im Channel ${channel.id}`);
      return { ok: false, reason: 'missing_perms' };
    }
    await fetched.send(content);
    console.log(`[${traceId}] safeChannelSend: Nachricht gesendet`);
    return { ok: true };
  } catch (err) {
    console.error(`[${traceId}] safeChannelSend: Fehler beim Senden:`, err);
    return { ok: false, reason: 'error', error: err };
  }
}

async function lockChannel(channel, applicantId) {
  try {
    console.log(`Sperre Channel ${channel.id} für ${applicantId || 'alle'}`);
    
    // Prüfe Bot-Berechtigungen vor dem Sperren
    const botMember = channel.guild.members.me;
    const botPerms = channel.permissionsFor(botMember);
    
    if (!botPerms?.has(PermissionFlagsBits.ManageChannels)) {
      console.warn(`Bot hat keine ManageChannels-Berechtigung für Channel ${channel.id}`);
      return; // Nicht kritisch, einfach überspringen
    }
    
    // Versuche @everyone zu sperren (nicht kritisch wenn fehlschlägt)
    try {
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
      console.log(`@everyone für Channel ${channel.id} gesperrt`);
    } catch (everyoneError) {
      console.warn(`Konnte @everyone nicht sperren für Channel ${channel.id}:`, everyoneError.message);
    }
    
    // Versuche Bewerber zu sperren (nicht kritisch wenn fehlschlägt)
    if (applicantId) {
      try {
        await channel.permissionOverwrites.edit(applicantId, { SendMessages: false });
        console.log(`Bewerber ${applicantId} für Channel ${channel.id} gesperrt`);
      } catch (applicantError) {
        console.warn(`Konnte Bewerber ${applicantId} nicht sperren für Channel ${channel.id}:`, applicantError.message);
      }
    }
    
    // Versuche Channel umzubenennen (nicht kritisch wenn fehlschlägt)
    if (!channel.name.startsWith('closed-')) {
      try {
        await channel.setName(`closed-${channel.name}`);
        console.log(`Channel ${channel.id} umbenannt zu closed-${channel.name}`);
      } catch (renameError) {
        console.warn(`Konnte Channel ${channel.id} nicht umbenennen:`, renameError.message);
      }
    }
    
    console.log(`Channel ${channel.id} Sperrung abgeschlossen`);
  } catch (error) {
    console.error(`Unerwarteter Fehler beim Sperren des Channels ${channel.id}:`, error);
    // Nicht weiterwerfen - Sperrung ist nicht kritisch
  }
}

function readTicketMeta(channel) {
  try {
    // Versuche zuerst aus der neuen Storage zu lesen
    const meta = ticketMetaStorage.get(channel.id);
    if (meta.caseId) {
      console.log(`Meta-Daten aus Storage gelesen für Channel ${channel.id}:`, meta);
      return meta;
    }
    
    // Fallback: Versuche JSON aus dem Topic zu parsen (für alte Tickets)
    const topic = channel.topic || '';
    console.log(`Channel ${channel.id} Topic:`, topic);
    
    if (topic.startsWith('{')) {
      const parsedMeta = JSON.parse(topic);
      console.log(`Meta-Daten aus Topic geparst für Channel ${channel.id}:`, parsedMeta);
      // Speichere in der neuen Storage für zukünftige Verwendung
      ticketMetaStorage.set(channel.id, parsedMeta);
      return parsedMeta;
    }
    
    // Für neue Tickets ohne Meta-Daten - erstelle eine mit caseId
    const newMeta = {
      caseId: makeCaseId(),
      applicantDiscordId: null,
      createdAt: Date.now(),
      claimedBy: null,
      claimedAt: null,
      closedBy: null,
      closedAt: null,
      status: 'open'
    };
    console.log(`Neue Meta-Daten erstellt für Channel ${channel.id}:`, newMeta);
    ticketMetaStorage.set(channel.id, newMeta);
    return newMeta;
  } catch (error) {
    console.error(`Fehler beim Lesen der Meta-Daten für Channel ${channel.id}:`, error);
    return ticketMetaStorage.get(channel.id);
  }
}

async function writeTicketMeta(channel, meta) {
  try {
    console.log(`Schreibe Meta-Daten für Channel ${channel.id}:`, meta);
    
    // Speichere Meta-Daten ZUERST in der Storage
    ticketMetaStorage.set(channel.id, meta);
    console.log(`Meta-Daten in Storage gespeichert für Channel ${channel.id}`);
    
    // Topic-Update komplett asynchron im Hintergrund (nicht blockierend)
    // Verwende setTimeout statt setImmediate für bessere Performance
    setTimeout(async () => {
      try {
        const topicText = `Whitelist-Ticket ${meta.caseId} | Status: ${meta.status} | Bewerber: ${meta.applicantDiscordId ? `<@${meta.applicantDiscordId}>` : 'Unbekannt'}`;
        await channel.setTopic(topicText);
        console.log(`Topic erfolgreich aktualisiert für Channel ${channel.id}`);
      } catch (topicError) {
        console.warn(`Topic-Update fehlgeschlagen für Channel ${channel.id}:`, topicError);
        // Topic-Fehler sind nicht kritisch, ignorieren
      }
    }, 0); // Sofort ausführen, aber asynchron
    
    console.log(`Meta-Daten erfolgreich gespeichert für Channel ${channel.id}`);
  } catch (error) {
    console.error(`Fehler beim Speichern der Meta-Daten für Channel ${channel.id}:`, error);
    throw error; // Fehler weiterwerfen für bessere Behandlung
  }
}

/* ===========================
   TICKET-CHANNEL ERSTELLUNG (NEU)
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

  // Kategorie validieren - StarCity Server Kategorie
  let parent = undefined;
  
  if (categoryId || STARCITY_CONFIG.categoryId) {
    const targetCategoryId = categoryId || STARCITY_CONFIG.categoryId;
    const cat = await guild.channels.fetch(targetCategoryId).catch(() => null);
    if (cat && cat.type === ChannelType.GuildCategory) {
      const check = hasNeededPermsIn(cat.id);
      if (check.ok) parent = cat.id;
      else console.warn('⚠️ Im Kategorie-Ordner fehlen mir Rechte. Erstelle Ticket OHNE parent.');
    } else {
      console.warn('⚠️ Kategorie nicht gefunden. Erstelle ohne parent.');
    }
  }

  const safeName = (form.charName || 'bewerber').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 20);
  const shortId = (form.websiteTicketId || applicantDiscordId || '0000').toString().slice(-4);
  const channelName = `whitelist-${safeName}-${shortId}`;
  const caseId = makeCaseId();

  // Berechtigungsüberschreibungen - StarCity Staff Rollen
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
  ];
  
  // Staff-Rollen hinzufügen
  STARCITY_CONFIG.staffRoles.forEach(roleId => {
    overwrites.push({ 
      id: roleId, 
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] 
    });
  });
  
  // Fallback für alte staffRoleId falls vorhanden
  if (staffRoleId && !STARCITY_CONFIG.staffRoles.includes(staffRoleId)) {
    overwrites.push({ 
      id: staffRoleId, 
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] 
    });
  }
  
  if (applicantDiscordId) {
    overwrites.push({ 
      id: applicantDiscordId, 
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] 
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent,
    permissionOverwrites: overwrites,
    reason: `Whitelist-Ticket für ${applicantTag || applicantDiscordId || 'Unbekannt'}`,
  });

  const meta = {
    caseId,
    applicantDiscordId,
    createdAt: Date.now(),
    claimedBy: null,
    claimedAt: null,
    closedBy: null,
    closedAt: null,
    status: 'open'
  };
  
  await writeTicketMeta(channel, meta);

  // Premium Embed-Design mit modernem Look
  const embed = new EmbedBuilder()
    .setColor(0x00A2FF) // StarCity Blau
    .setTitle('🎫 Whitelist-Ticket erstellt')
    .setDescription([
      '**Willkommen bei StarCity!** 🌟',
      '',
      'Ihre Bewerbung wurde erfolgreich eingereicht und ist in unserem System registriert.',
      'Unser Team wird sich zeitnah um Ihr Anliegen kümmern.',
      '',
      '💡 **Hinweis:** Bitte halten Sie alle Kommunikation in diesem Ticket gebündelt.',
    ].join('\n'))
    .setFooter({ 
      text: `${caseId} • Status: Offen • StarCity Bot`, 
      iconURL: BRAND.icon || undefined 
    })
    .setTimestamp()
    .setThumbnail(BRAND.icon || 'https://cdn.discordapp.com/emojis/1234567890123456789.png');

  if (BRAND.icon) {
    embed.setAuthor({ 
      name: BRAND.name, 
      iconURL: BRAND.icon,
      url: 'https://starcity-rp.de'
    });
  } else {
    embed.setAuthor({ 
      name: BRAND.name,
      url: 'https://starcity-rp.de'
    });
  }
  
  if (BRAND.banner) {
    embed.setImage(BRAND.banner);
  }

  // Moderner Header mit Logo als Author-Icon ist gesetzt; zusätzlich kleiner Footer-Icon bereits vorhanden.

  const bewerberText = applicantDiscordId ? `<@${applicantDiscordId}> (${clean(form.discordTag || applicantTag)})` : clean(form.discordTag || applicantTag);

  // Premium Feld-Struktur mit Icons und besserer Organisation
  embed.addFields(
    { 
      name: '👤 Bewerber', 
      value: trunc(bewerberText, 256), 
      inline: false 
    },
    { 
      name: '🎭 Charakter', 
      value: trunc(form.charName, 128) || '—', 
      inline: true 
    },
    { 
      name: '🎂 Alter', 
      value: form.alter ? `${form.alter} Jahre` : '—', 
      inline: true 
    },
    { 
      name: '🔗 Steam Hex', 
      value: trunc(form.steamHex, 64) || '—', 
      inline: true 
    },
    { 
      name: '💬 Discord', 
      value: trunc(form.discordTag, 128) || '—', 
      inline: true 
    },
    { 
      name: '🌍 Zeitzone', 
      value: trunc(form.timezone, 64) || '—', 
      inline: true 
    },
  );

  if (form.howFound) {
    embed.addFields({ 
      name: '🔍 Wie gefunden', 
      value: trunc(form.howFound, 1024), 
      inline: false 
    });
  }
  
  if (form.deskItem) {
    embed.addFields({ 
      name: '📝 Hinweis', 
      value: trunc(form.deskItem, 1024), 
      inline: false 
    });
  }

  const qa = normalizeAnswers(form.answers);
  if (qa.length > 0) {
    embed.addFields({ 
      name: '❓ Bewerbungsfragen', 
      value: 'Die Antworten finden Sie unten:', 
      inline: false 
    });
    
    for (let i = 0; i < qa.length && i < 8; i++) {
      embed.addFields({ 
        name: `**${i + 1}.** ${trunc(qa[i].q, 150)}`, 
        value: `> ${trunc(qa[i].a, 800)}`, 
        inline: false 
      });
    }
    
    if (qa.length > 8) {
      embed.addFields({ 
        name: '📋 Weitere Antworten', 
        value: `*${qa.length - 8} weitere Antworten wurden eingereicht*`, 
        inline: false 
      });
    }
  }

  // StarCity Staff Rollen für Mention
  const staffMention = STARCITY_CONFIG.staffRoles.map(roleId => `<@&${roleId}>`).join(' ');
  
  const sent = await channel.send({
    content: `${staffMention} Neues Whitelist-Ticket`,
    embeds: [embed],
    components: [buildTicketButtons()],
    allowedMentions: { roles: STARCITY_CONFIG.staffRoles },
  });

  meta.originalMessageId = sent.id;
  await writeTicketMeta(channel, meta);

  return { channel, caseId, messageId: sent.id };
}

/* ===========================
   TRANSCRIPT FUNKTION
   =========================== */
async function createTranscript(channel, meta) {
  try {
    console.log(`Erstelle Transcript für Channel ${channel.id}`);
    
    const messages = [];
    let lastId = null;
    let messageCount = 0;
    const maxMessages = 1000; // Limit für Performance
    
    // Nachrichten sammeln
    while (messageCount < maxMessages) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      
      const batch = await channel.messages.fetch(options);
      if (batch.size === 0) break;
      
      for (const message of batch.values()) {
        messages.unshift(message); // Älteste zuerst
        messageCount++;
      }
      
      lastId = batch.last()?.id;
    }
    
    // HTML Transcript erstellen
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const header = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Transcript ${esc(meta.caseId)}</title>
<style>
  body{font-family:Inter,Segoe UI,Arial,sans-serif;background:#0b1220;color:#e6edf3;margin:0}
  .wrap{max-width:960px;margin:0 auto;padding:24px}
  .hero{display:flex;align-items:center;gap:16px;margin-bottom:16px}
  .hero img.logo{width:48px;height:48px;border-radius:8px}
  .banner{width:100%;border-radius:10px;margin:8px 0}
  .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0}
  .meta .card{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:12px}
  .msg{display:flex;gap:12px;padding:12px;border-bottom:1px solid #1e293b}
  .avatar{width:36px;height:36px;border-radius:50%;flex:0 0 36px}
  .msg .head{font-size:12px;color:#94a3b8}
  .msg .content{white-space:pre-wrap;word-break:break-word;margin-top:2px}
  .attach, .embed{margin-top:8px;font-size:12px;color:#cbd5e1}
  .time{color:#64748b}
  .title{font-weight:600}
</style></head><body><div class="wrap">
  <div class="hero">
    ${BRAND.icon ? `<img class="logo" src="${esc(BRAND.icon)}" alt="logo"/>` : ''}
    <div>
      <div class="title">StarCity Ticket Transcript</div>
      <div class="time">${esc(meta.caseId)} • #${esc(channel.name)}</div>
    </div>
  </div>
  ${BRAND.banner ? `<img class="banner" src="${esc(BRAND.banner)}" alt="banner"/>` : ''}
  <div class="meta">
    <div class="card"><div class="title">Bewerber</div>${meta.applicantDiscordId ? `@${meta.applicantDiscordId}` : 'Unbekannt'}</div>
    <div class="card"><div class="title">Status</div>${esc(meta.status)}</div>
    <div class="card"><div class="title">Erstellt</div>${new Date(meta.createdAt).toLocaleString('de-DE')}</div>
    ${meta.claimedBy ? `<div class="card"><div class="title">Übernommen von</div>@${esc(meta.claimedBy)}</div>` : ''}
    ${meta.closedBy ? `<div class="card"><div class="title">Geschlossen von</div>@${esc(meta.closedBy)}</div>` : ''}
  </div>
`;

    const parts = [header];
    for (const message of messages) {
      const avatar = message.author?.displayAvatarURL?.({ size: 64 }) || message.author?.avatarURL?.() || '';
      const line = [`<div class="msg">`];
      line.push(avatar ? `<img class="avatar" src="${esc(avatar)}" alt="avatar"/>` : `<div class="avatar" style="background:#1f2937"></div>`);
      line.push(`<div><div class="head"><span class="title">${esc(message.author?.tag || message.author?.username || 'Unbekannt')}</span> <span class="time">${new Date(message.createdTimestamp).toLocaleString('de-DE')}</span></div>`);
      const content = message.content ? esc(message.content) : '';
      if (content) line.push(`<div class="content">${content}</div>`);
      if (message.embeds?.length) {
        for (const emb of message.embeds) {
          const t = emb.title ? esc(emb.title) : '';
          const d = emb.description ? esc(emb.description) : '';
          if (t || d) line.push(`<div class="embed">${t ? `<div class="title">${t}</div>` : ''}${d ? `<div>${d}</div>` : ''}</div>`);
        }
      }
      if (message.attachments?.size) {
        for (const att of message.attachments.values()) {
          line.push(`<div class="attach">📎 <a href="${esc(att.url)}" target="_blank" rel="noopener">${esc(att.name)}</a></div>`);
        }
      }
      line.push(`</div></div>`);
      parts.push(line.join(''));
    }
    parts.push(`</div></body></html>`);
    return parts.join('');
    
  } catch (error) {
    console.error(`Fehler beim Erstellen des Transcripts:`, error);
    return `# Transcript für Ticket ${meta.caseId}\n\nFehler beim Erstellen des Transcripts: ${error.message}`;
  }
}

/* ===========================
   SLASH COMMAND HANDLER
   =========================== */
async function handleAddUser(interaction, traceId) {
  try {
    const user = interaction.options.getUser('user', true);
    const channel = interaction.channel;
    
    // Prüfe ob es ein Ticket ist
    const meta = readTicketMeta(channel);
    if (!meta.caseId) {
      await interaction.reply({ content: '❌ Dies ist kein gültiges Ticket.', flags: 64 });
      return;
    }

    // Berechtigungen prüfen
    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({ content: '❌ Mir fehlen die nötigen Berechtigungen.', flags: 64 });
      return;
    }

    await interaction.deferReply({ flags: 64 });

    // Benutzer zum Channel hinzufügen
    await channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });

    await interaction.editReply({ 
      content: `✅ ${user} wurde zum Ticket hinzugefügt!` 
    });

    // Channel-Nachricht
    const addEmbed = new EmbedBuilder()
      .setColor(0x00FF88)
      .setTitle('👤 Benutzer hinzugefügt')
      .setDescription(`${user} wurde von <@${interaction.user.id}> zum Ticket hinzugefügt.`)
      .setFooter({ text: `${meta.caseId} • Ticket-Update` })
      .setTimestamp();

    await safeChannelSend(channel, interaction.guild, { embeds: [addEmbed] }, traceId);

  } catch (error) {
    console.error(`[${traceId}] Fehler beim Hinzufügen des Benutzers:`, error);
    await interaction.editReply({ content: '❌ Fehler beim Hinzufügen des Benutzers.' });
  }
}

async function handleRemoveUser(interaction, traceId) {
  try {
    const user = interaction.options.getUser('user', true);
    const channel = interaction.channel;
    
    // Prüfe ob es ein Ticket ist
    const meta = readTicketMeta(channel);
    if (!meta.caseId) {
      await interaction.reply({ content: '❌ Dies ist kein gültiges Ticket.', flags: 64 });
      return;
    }

    // Berechtigungen prüfen
    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({ content: '❌ Mir fehlen die nötigen Berechtigungen.', flags: 64 });
      return;
    }

    await interaction.deferReply({ flags: 64 });

    // Benutzer aus Channel entfernen
    await channel.permissionOverwrites.edit(user.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false
    });

    await interaction.editReply({ 
      content: `✅ ${user} wurde aus dem Ticket entfernt!` 
    });

    // Channel-Nachricht
    const removeEmbed = new EmbedBuilder()
      .setColor(0xFF4444)
      .setTitle('👤 Benutzer entfernt')
      .setDescription(`${user} wurde von <@${interaction.user.id}> aus dem Ticket entfernt.`)
      .setFooter({ text: `${meta.caseId} • Ticket-Update` })
      .setTimestamp();

    await safeChannelSend(channel, interaction.guild, { embeds: [removeEmbed] }, traceId);

  } catch (error) {
    console.error(`[${traceId}] Fehler beim Entfernen des Benutzers:`, error);
    await interaction.editReply({ content: '❌ Fehler beim Entfernen des Benutzers.' });
  }
}

async function handleTicketInfo(interaction, traceId) {
  try {
    const channel = interaction.channel;
    const meta = readTicketMeta(channel);
    
    if (!meta.caseId) {
      await interaction.reply({ content: '❌ Dies ist kein gültiges Ticket.', flags: 64 });
      return;
    }

    await interaction.deferReply({ flags: 64 });

    const infoEmbed = new EmbedBuilder()
      .setColor(0x00A2FF)
      .setTitle('📋 Ticket-Informationen')
      .addFields(
        { name: '🎫 Case ID', value: meta.caseId, inline: true },
        { name: '👤 Bewerber', value: meta.applicantDiscordId ? `<@${meta.applicantDiscordId}>` : 'Unbekannt', inline: true },
        { name: '📅 Erstellt', value: `<t:${Math.floor(meta.createdAt / 1000)}:R>`, inline: true },
        { name: '📊 Status', value: meta.status, inline: true },
        { name: '🎯 Übernommen von', value: meta.claimedBy ? `<@${meta.claimedBy}>` : 'Niemand', inline: true },
        { name: '🔒 Geschlossen von', value: meta.closedBy ? `<@${meta.closedBy}>` : 'Niemand', inline: true }
      )
      .setFooter({ text: 'StarCity Bot • Ticket-Info' })
      .setTimestamp();

    if (meta.claimedAt) {
      infoEmbed.addFields({ name: '⏰ Übernommen', value: `<t:${Math.floor(meta.claimedAt / 1000)}:R>`, inline: true });
    }
    if (meta.closedAt) {
      infoEmbed.addFields({ name: '⏰ Geschlossen', value: `<t:${Math.floor(meta.closedAt / 1000)}:R>`, inline: true });
    }

    await interaction.editReply({ embeds: [infoEmbed] });

  } catch (error) {
    console.error(`[${traceId}] Fehler beim Anzeigen der Ticket-Info:`, error);
    await interaction.editReply({ content: '❌ Fehler beim Anzeigen der Ticket-Informationen.' });
  }
}

async function handleTicketRename(interaction, traceId) {
  try {
    const newName = interaction.options.getString('name', true);
    const channel = interaction.channel;
    const meta = readTicketMeta(channel);
    
    if (!meta.caseId) {
      await interaction.reply({ content: '❌ Dies ist kein gültiges Ticket.', flags: 64 });
      return;
    }

    // SOFORT antworten
    await interaction.deferReply({ flags: 64 });

    const sanitized = newName
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 100) || 'ticket';

    const oldName = channel.name;
    
    // Channel umbenennen (synchron)
    await channel.setName(sanitized);

    // Meta aktualisieren (schnell)
    meta.renamedBy = interaction.user.id;
    meta.renamedAt = Date.now();
    meta.originalName = oldName;
    ticketMetaStorage.set(channel.id, meta);

    // SOFORT Bestätigung senden
    await interaction.editReply({ 
      content: `✅ Ticket erfolgreich umbenannt zu: **${sanitized}**` 
    });

    // Channel-Nachricht asynchron im Hintergrund (nicht blockierend)
    setImmediate(async () => {
      try {
        const renameEmbed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle('✏️ Ticket umbenannt')
          .setDescription(`<@${interaction.user.id}> hat das Ticket umbenannt.`)
          .addFields(
            { name: 'Neuer Name', value: `\`${sanitized}\``, inline: true },
            { name: 'Alter Name', value: `\`${oldName}\``, inline: true }
          )
          .setFooter({ text: `${meta.caseId} • Ticket-Update` })
          .setTimestamp();

        await safeChannelSend(channel, interaction.guild, { embeds: [renameEmbed] }, traceId);
      } catch (error) {
        console.warn(`[${traceId}] Fehler bei Channel-Nachricht für Rename:`, error);
      }
    });

  } catch (error) {
    console.error(`[${traceId}] Fehler beim Umbenennen:`, error);
    await interaction.editReply({ content: '❌ Fehler beim Umbenennen des Tickets.' });
  }
}

async function handleTicketClose(interaction, traceId) {
  try {
    const channel = interaction.channel;
    const meta = readTicketMeta(channel);
    
    if (!meta.caseId) {
      await interaction.reply({ content: '❌ Dies ist kein gültiges Ticket.', flags: 64 });
      return;
    }

    if (meta.status === 'closed') {
      await interaction.reply({ content: '⚠️ Das Ticket ist bereits geschlossen.', flags: 64 });
      return;
    }

    await interaction.deferReply({ flags: 64 });

    // Meta aktualisieren
    meta.closedBy = interaction.user.id;
    meta.closedAt = Date.now();
    meta.status = 'closed';
    ticketMetaStorage.set(channel.id, meta);

    // Buttons aktualisieren
    const newButtons = buildTicketButtons({ claimed: !!meta.claimedBy, closed: true });
    await interaction.message?.edit({ components: [newButtons] }).catch(() => {});

    await interaction.editReply({ 
      content: `🔒 Ticket erfolgreich geschlossen! Transcript wird erstellt...` 
    });

    // Channel-Nachricht
    const closeEmbed = new EmbedBuilder()
      .setColor(0xFF4444)
      .setTitle('🔒 Ticket geschlossen')
      .setDescription(`<@${interaction.user.id}> hat das Ticket geschlossen.`)
      .setFooter({ text: `${meta.caseId} • Status: Geschlossen` })
      .setTimestamp();

    await safeChannelSend(channel, interaction.guild, { embeds: [closeEmbed] }, traceId);

    // Channel sperren
    await lockChannel(channel, meta.applicantDiscordId);

    // Transcript erstellen und Channel löschen (asynchron im Hintergrund)
    setImmediate(async () => {
      try {
        console.log(`[${traceId}] Erstelle Transcript für geschlossenes Ticket ${meta.caseId}`);
        
        // Transcript erstellen
        const transcript = await createTranscript(channel, meta);
        
        // Transcript in den festen Log-Channel senden
        const logChannelId = STARCITY_CONFIG.logChannelId;
        if (logChannelId) {
          try {
            const logChannel = await interaction.guild.channels.fetch(logChannelId);
            if (logChannel) {
              // Transcript in Datei umwandeln
              const buffer = Buffer.from(transcript, 'utf8');
              const attachment = {
                name: `transcript-${meta.caseId}-${Date.now()}.html`,
                attachment: buffer
              };
              
              const transcriptEmbed = new EmbedBuilder()
                .setColor(0x00A2FF)
                .setTitle('📄 Ticket Transcript erstellt')
                .setDescription(`Transcript für Ticket **${meta.caseId}** wurde erstellt.`)
                .addFields(
                  { name: 'Channel', value: `#${channel.name}`, inline: true },
                  { name: 'Bewerber', value: meta.applicantDiscordId ? `<@${meta.applicantDiscordId}>` : 'Unbekannt', inline: true },
                  { name: 'Geschlossen von', value: `<@${meta.closedBy}>`, inline: true }
                )
                .setTimestamp();
              
              await logChannel.send({
                content: `📥 Geschlossenes Ticket verarbeitet: ${meta.caseId}`,
                embeds: [transcriptEmbed],
                files: [attachment]
              });
              
              console.log(`[${traceId}] Transcript erfolgreich in Log-Channel gesendet`);
            }
          } catch (logError) {
            console.warn(`[${traceId}] Fehler beim Senden des Transcripts:`, logError);
          }
        }
        
        // Warte 2 Sekunden, dann Channel löschen und Ticket aus Storage entfernen
        setTimeout(async () => {
          try {
            console.log(`[${traceId}] Lösche Channel ${channel.id} nach 2 Sekunden`);
            await channel.delete('Ticket geschlossen - automatische Löschung');
            console.log(`[${traceId}] Channel erfolgreich gelöscht`);
            ticketMetaStorage.delete(channel.id);
            console.log(`[${traceId}] Ticket-Metadaten entfernt`);
          } catch (deleteError) {
            console.error(`[${traceId}] Fehler beim Löschen des Channels:`, deleteError);
          }
        }, 2000);
        
      } catch (transcriptError) {
        console.error(`[${traceId}] Fehler beim Erstellen des Transcripts:`, transcriptError);
        
        // Channel trotzdem nach 5 Sekunden löschen und Ticket aus Storage entfernen
        setTimeout(async () => {
          try {
            await channel.delete('Ticket geschlossen - automatische Löschung (ohne Transcript)');
            ticketMetaStorage.delete(channel.id);
          } catch (deleteError) {
            console.error(`[${traceId}] Fehler beim Löschen des Channels:`, deleteError);
          }
        }, 5000);
      }
    });

  } catch (error) {
    console.error(`[${traceId}] Fehler beim Schließen:`, error);
    await interaction.editReply({ content: '❌ Fehler beim Schließen des Tickets.' });
  }
}

async function handleTicketTranscript(interaction, traceId) {
  try {
    const channel = interaction.channel;
    const meta = readTicketMeta(channel);
    
    if (!meta.caseId) {
      await interaction.reply({ content: '❌ Dies ist kein gültiges Ticket.', flags: 64 });
      return;
    }

    await interaction.deferReply({ flags: 64 });

    // Transcript erstellen
    const transcript = await createTranscript(channel, meta);
    
    // Transcript in Datei umwandeln
    const buffer = Buffer.from(transcript, 'utf8');
    const attachment = {
      name: `transcript-${meta.caseId}-${Date.now()}.md`,
      attachment: buffer
    };
    
    const transcriptEmbed = new EmbedBuilder()
      .setColor(0x00A2FF)
      .setTitle('📄 Ticket Transcript')
      .setDescription(`Transcript für Ticket **${meta.caseId}** wurde erstellt.`)
      .addFields(
        { name: 'Channel', value: `#${channel.name}`, inline: true },
        { name: 'Bewerber', value: meta.applicantDiscordId ? `<@${meta.applicantDiscordId}>` : 'Unbekannt', inline: true },
        { name: 'Status', value: meta.status, inline: true }
      )
      .setFooter({ text: 'StarCity Bot • Transcript' })
      .setTimestamp();

    await interaction.editReply({ 
      embeds: [transcriptEmbed], 
      files: [attachment] 
    });

  } catch (error) {
    console.error(`[${traceId}] Fehler beim Erstellen des Transcripts:`, error);
    await interaction.editReply({ content: '❌ Fehler beim Erstellen des Transcripts.' });
  }
}

/* ===========================
   INTERAKTIONEN (SLASH + BUTTONS) - NEU
   =========================== */
client.on('interactionCreate', async (interaction) => {
  const traceId = interaction.id;
  const startTime = Date.now();
  
  console.log(`[${traceId}] ${interaction.type} by ${interaction.user?.tag || interaction.user?.id}`);

  try {
    // SLASH COMMANDS
    if (interaction.isChatInputCommand()) {
      const commandName = interaction.commandName;
      
      // Staff-Check für alle Commands außer ticket-test
      if (commandName !== 'ticket-test') {
        const isStaff = STARCITY_CONFIG.staffRoles.some(roleId => 
          interaction.member?.roles?.cache?.has?.(roleId)
        ) || false;
        
        if (!isStaff) {
          await interaction.reply({ content: '❌ Nur Staff-Mitglieder können diese Aktion ausführen.', flags: 64 });
          return;
        }
      }
      
      // Command-spezifische Handler
      if (commandName === 'ticket-test') {
        const charName = interaction.options.getString('charname', true);
        const key = idempotency.createKey('slash', STARCITY_CONFIG.guildId, interaction.user.id, charName);
        
        // Idempotenz prüfen
        const check = idempotency.isAllowed(key);
        if (!check.allowed) {
          const message = check.reason === 'inflight' 
            ? '⏳ Ticket wird bereits erstellt...' 
            : `⏳ Zu viele Tickets in kurzer Zeit. Bitte warte ${check.age || 60} Sekunden.`;
          
          await interaction.reply({ content: message, flags: 64 });
          return;
        }

        // SOFORT antworten um Timeout zu vermeiden
        await interaction.deferReply({ flags: 64 });

        try {
          const { channel } = await createTicketChannel({
            guildId: STARCITY_CONFIG.guildId,
            categoryId: STARCITY_CONFIG.categoryId,
            staffRoleId: null, // Nicht mehr benötigt, da hardcoded
            applicantDiscordId: interaction.user.id,
            applicantTag: interaction.user.username,
            form: {
              charName,
              alter: 19,
              steamHex: '110000112345678',
              discordTag: interaction.user.username,
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

          await interaction.editReply({ 
            content: `✅ Ticket erfolgreich erstellt: https://discord.com/channels/${STARCITY_CONFIG.guildId}/${channel.id}` 
          });
          
        } catch (error) {
          console.error(`[${traceId}] Ticket-Erstellung fehlgeschlagen:`, error);
          await interaction.editReply({ content: '❌ Fehler beim Erstellen des Tickets. Bitte versuche es erneut.' });
        } finally {
          idempotency.markComplete(key);
        }
        return;
      }

      // Staff-Commands (alle anderen)
      if (commandName === 'add') {
        await handleAddUser(interaction, traceId);
        return;
      }

      if (commandName === 'remove') {
        await handleRemoveUser(interaction, traceId);
        return;
      }

      if (commandName === 'ticket-info') {
        await handleTicketInfo(interaction, traceId);
        return;
      }

      if (commandName === 'ticket-rename') {
        await handleTicketRename(interaction, traceId);
        return;
      }

      if (commandName === 'ticket-close') {
        await handleTicketClose(interaction, traceId);
        return;
      }

      if (commandName === 'ticket-transcript') {
        await handleTicketTranscript(interaction, traceId);
        return;
      }
    }

    // BUTTON INTERACTIONS
    if (interaction.isButton()) {
      console.log(`[${traceId}] Button-Klick: ${interaction.customId}`);
      
      // StarCity Staff Rollen prüfen
      const isStaff = STARCITY_CONFIG.staffRoles.some(roleId => 
        interaction.member?.roles?.cache?.has?.(roleId)
      ) || false;
      
      console.log(`[${traceId}] Staff-Check: ${isStaff} (StarCity Staff Rollen: ${STARCITY_CONFIG.staffRoles.join(', ')})`);
      if (!isStaff) {
        await interaction.reply({ content: '❌ Nur Staff-Mitglieder können diese Aktion ausführen.', flags: 64 });
        return;
      }

      const channel = interaction.channel;
      const meta = readTicketMeta(channel);
      console.log(`[${traceId}] Meta-Daten:`, meta);
      
      if (!meta.caseId) {
        console.log(`[${traceId}] Kein gültiges Ticket (kein caseId)`);
        await interaction.reply({ content: '❌ Dies ist kein gültiges Ticket.', flags: 64 });
        return;
      }

      // Berechtigungen prüfen
      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms?.has(PermissionFlagsBits.ManageChannels)) {
        console.log(`[${traceId}] Fehlende ManageChannels-Berechtigung`);
        await interaction.reply({ content: '❌ Mir fehlen die nötigen Berechtigungen.', flags: 64 });
        return;
      }

      if (interaction.customId === 'ticket_claim') {
        console.log(`[${traceId}] Verarbeite Ticket-Übernahme`);
        if (meta.claimedBy) {
          await interaction.reply({ content: '⚠️ Dieses Ticket wurde bereits übernommen.', flags: 64 });
          return;
        }

        // SOFORT antworten um Timeout zu vermeiden
        await interaction.deferReply({ flags: 64 });

        // Ephemere Bestätigung
        await interaction.editReply({ content: '✅ Ticket erfolgreich übernommen!' });

          // Buttons aktualisieren
          console.log(`[${traceId}] Aktualisiere Buttons`);
          try {
            const newButtons = buildTicketButtons({ claimed: true, closed: false });
            console.log(`[${traceId}] Neue Buttons erstellt:`, newButtons.components.map(b => b.data.label));
            await interaction.message.edit({ 
              components: [newButtons] 
            });
            console.log(`[${traceId}] Buttons erfolgreich aktualisiert`);
          } catch (buttonError) {
            console.error(`[${traceId}] Fehler beim Aktualisieren der Buttons:`, buttonError);
          }

          // Meta aktualisieren
          console.log(`[${traceId}] Aktualisiere Meta-Daten`);
          meta.claimedBy = interaction.user.id;
          meta.claimedAt = Date.now();
          meta.status = 'claimed';
          
          try {
            await writeTicketMeta(channel, meta);
            console.log(`[${traceId}] Meta-Daten erfolgreich aktualisiert:`, meta);
            
            // Meta-Daten sofort in der Storage aktualisieren
            ticketMetaStorage.set(channel.id, meta);
            console.log(`[${traceId}] Meta-Daten auch in Storage aktualisiert`);
          } catch (metaError) {
            console.error(`[${traceId}] Fehler beim Speichern der Meta-Daten:`, metaError);
          }

          // Channel-Nachricht (robust) - Premium Design
          console.log(`[${traceId}] Sende Channel-Nachricht`);
          {
            const claimEmbed = new EmbedBuilder()
              .setColor(0x00FF88) // Grün für Erfolg
              .setTitle('✅ Ticket übernommen')
              .setDescription([
                `<@${interaction.user.id}> hat das Ticket übernommen.`,
                '',
                '**Was passiert jetzt?**',
                '• Unser Team kümmert sich um Ihre Bewerbung',
                '• Sie erhalten zeitnah eine Rückmeldung',
                '• Bitte haben Sie Geduld bei der Bearbeitung',
                '',
                '💡 *Bei Fragen können Sie sich gerne melden.*'
              ].join('\n'))
              .setFooter({ text: `${meta.caseId} • Status: In Bearbeitung` })
              .setTimestamp();
              
            const result = await safeChannelSend(channel, interaction.guild, { embeds: [claimEmbed] }, traceId);
            if (!result.ok) {
              console.warn(`[${traceId}] Konnte keine Channel-Nachricht senden:`, result.reason);
            }
          }
          
          return;
        }

      if (interaction.customId === 'ticket_close') {
        console.log(`[${traceId}] Verarbeite Ticket-Schließung`);
        
        // SOFORT antworten um Timeout zu vermeiden
        await interaction.deferReply({ flags: 64 });

        // Ephemere Bestätigung
        await interaction.editReply({ content: '🔒 Ticket erfolgreich geschlossen!' });

          // Buttons aktualisieren
          console.log(`[${traceId}] Aktualisiere Buttons`);
          try {
            const newButtons = buildTicketButtons({ claimed: !!meta.claimedBy, closed: true });
            console.log(`[${traceId}] Neue Buttons erstellt:`, newButtons.components.map(b => b.data.label));
            await interaction.message.edit({ 
              components: [newButtons] 
            });
            console.log(`[${traceId}] Buttons erfolgreich aktualisiert`);
          } catch (buttonError) {
            console.error(`[${traceId}] Fehler beim Aktualisieren der Buttons:`, buttonError);
          }

          // Meta aktualisieren
          console.log(`[${traceId}] Aktualisiere Meta-Daten`);
          meta.closedBy = interaction.user.id;
          meta.closedAt = Date.now();
          meta.status = 'closed';
          
          try {
            await writeTicketMeta(channel, meta);
            console.log(`[${traceId}] Meta-Daten erfolgreich aktualisiert`);
            
            // Meta-Daten sofort in der Storage aktualisieren
            ticketMetaStorage.set(channel.id, meta);
            console.log(`[${traceId}] Meta-Daten auch in Storage aktualisiert`);
          } catch (metaError) {
            console.error(`[${traceId}] Fehler beim Speichern der Meta-Daten:`, metaError);
          }

          // Channel-Nachricht (vor dem Sperren senden) - Premium Design
          console.log(`[${traceId}] Sende Channel-Nachricht`);
          {
            const closeEmbed = new EmbedBuilder()
              .setColor(0xFF4444) // Rot für Schließung
              .setTitle('🔒 Ticket geschlossen')
              .setDescription([
                `<@${interaction.user.id}> hat das Ticket geschlossen.`,
                '',
                '**Vielen Dank für Ihre Bewerbung bei StarCity!**',
                '',
                '**Was passiert als nächstes?**',
                '• Ihre Bewerbung wird von unserem Team geprüft',
                '• Sie erhalten eine Benachrichtigung über das Ergebnis',
                '• Bei Fragen können Sie sich gerne an uns wenden',
                '',
                '🌟 *Wir freuen uns auf Sie in StarCity!*'
              ].join('\n'))
              .setFooter({ text: `${meta.caseId} • Status: Geschlossen` })
              .setTimestamp();
              
            const result = await safeChannelSend(channel, interaction.guild, { embeds: [closeEmbed] }, traceId);
            if (!result.ok) {
              console.warn(`[${traceId}] Konnte keine Channel-Nachricht senden:`, result.reason);
            }
          }

          // Channel sperren (nachdem die Nachricht gesendet wurde)
          console.log(`[${traceId}] Sperre Channel`);
          try {
            await lockChannel(channel, meta.applicantDiscordId);
            console.log(`[${traceId}] Channel erfolgreich gesperrt`);
          } catch (lockError) {
            console.error(`[${traceId}] Fehler beim Sperren des Channels:`, lockError);
          }

          // Transcript + Log + Löschen (wie bei Slash-Command)
          setImmediate(async () => {
            try {
              const transcript = await createTranscript(channel, meta);
              const logChannelId = STARCITY_CONFIG.logChannelId;
              if (logChannelId) {
                try {
                  const logChannel = await interaction.guild.channels.fetch(logChannelId);
                  if (logChannel) {
                    const buffer = Buffer.from(transcript, 'utf8');
                    const attachment = {
                      name: `transcript-${meta.caseId}-${Date.now()}.html`,
                      attachment: buffer
                    };
                    const transcriptEmbed = new EmbedBuilder()
                      .setColor(0x00A2FF)
                      .setTitle('📄 Ticket Transcript erstellt')
                      .setDescription(`Transcript für Ticket **${meta.caseId}** wurde erstellt.`)
                      .addFields(
                        { name: 'Channel', value: `#${channel.name}`, inline: true },
                        { name: 'Bewerber', value: meta.applicantDiscordId ? `<@${meta.applicantDiscordId}>` : 'Unbekannt', inline: true },
                        { name: 'Geschlossen von', value: `<@${meta.closedBy}>`, inline: true }
                      )
                      .setTimestamp();
                    await logChannel.send({
                      content: `📥 Geschlossenes Ticket verarbeitet: ${meta.caseId}`,
                      embeds: [transcriptEmbed],
                      files: [attachment]
                    });
                  }
                } catch (e) {
                  console.warn(`[${traceId}] Konnte Transcript nicht in Log-Channel senden:`, e);
                }
              }

              setTimeout(async () => {
                try {
                  await channel.delete('Ticket geschlossen - automatische Löschung');
                  ticketMetaStorage.delete(channel.id);
                } catch (e) {
                  console.error(`[${traceId}] Fehler beim Löschen des Channels:`, e);
                }
              }, 5000);
            } catch (e) {
              console.error(`[${traceId}] Fehler im Close-Flow (Button):`, e);
              setTimeout(async () => {
                try {
                  await channel.delete('Ticket geschlossen - automatische Löschung (Fallback)');
                  ticketMetaStorage.delete(channel.id);
                } catch {}
              }, 10000);
            }
          });

          return;
        }

      if (interaction.customId === 'ticket_rename') {
        console.log(`[${traceId}] Verarbeite Ticket-Umbenennung`);
        
        // SOFORT Modal erstellen und anzeigen (keine Verzögerung)
        const modal = new ModalBuilder()
          .setCustomId('ticket_rename_modal')
          .setTitle('✏️ Ticket umbenennen');

        const nameInput = new TextInputBuilder()
          .setCustomId('new_channel_name')
          .setLabel('🎫 Neuer Channel-Name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('z.B. whitelist-max-mustermann-1234')
          .setValue(interaction.channel.name)
          .setRequired(true)
          .setMaxLength(100)
          .setMinLength(3);

        const actionRow = new ActionRowBuilder().addComponents(nameInput);
        modal.addComponents(actionRow);

        // Modal SOFORT anzeigen (keine Checks davor)
        try {
          await interaction.showModal(modal);
          console.log(`[${traceId}] Modal erfolgreich angezeigt`);
        } catch (modalError) {
          console.error(`[${traceId}] Modal-Fehler:`, modalError);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Fehler beim Öffnen des Modals.', flags: 64 });
          }
        }
        return;
      }

      console.log(`[${traceId}] Unbekannter Button: ${interaction.customId}`);
      await interaction.reply({ content: '❌ Unbekannte Aktion.', flags: 64 });
    }

    // MODAL SUBMITS
    if (interaction.isModalSubmit()) {
      console.log(`[${traceId}] Modal-Submit: ${interaction.customId}`);
      
      if (interaction.customId === 'ticket_rename_modal') {
        console.log(`[${traceId}] Starte Modal-Verarbeitung`);
        
        // SOFORT antworten um Timeout zu vermeiden
        try {
          await interaction.deferReply({ flags: 64 });
        } catch (deferError) {
          console.error(`[${traceId}] Defer-Fehler:`, deferError);
          // Wenn defer fehlschlägt, versuche reply
          try {
            await interaction.reply({ content: '⏳ Verarbeite Umbenennung...', flags: 64 });
          } catch (replyError) {
            console.error(`[${traceId}] Reply-Fehler:`, replyError);
            return; // Interaction ist abgelaufen
          }
        }
        
        try {
          const rawName = interaction.fields.getTextInputValue('new_channel_name');
          console.log(`[${traceId}] Raw Name erhalten: ${rawName}`);
          
          const sanitized = rawName
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-{2,}/g, '-')
            .slice(0, 100) || 'ticket';
          console.log(`[${traceId}] Neuer Channel-Name (sanitized): ${sanitized} (raw: ${rawName})`);

          const oldName = interaction.channel.name;
          console.log(`[${traceId}] Alter Channel-Name: ${oldName}`);

          // Channel umbenennen (sofort ausführen)
          console.log(`[${traceId}] Benenne Channel um...`);
          try {
            await interaction.channel.setName(sanitized);
            console.log(`[${traceId}] Channel erfolgreich umbenannt zu: ${sanitized}`);
          } catch (renameError) {
            console.warn(`[${traceId}] Channel-Umbenennung fehlgeschlagen:`, renameError);
          }
          
          // Meta aktualisieren (ohne auf Channel-Umbenennung zu warten)
          console.log(`[${traceId}] Aktualisiere Meta-Daten...`);
          const meta = readTicketMeta(interaction.channel);
          meta.renamedBy = interaction.user.id;
          meta.renamedAt = Date.now();
          meta.originalName = oldName;
          
          // Meta-Daten SOFORT in Storage speichern (nicht blockierend)
          ticketMetaStorage.set(interaction.channel.id, meta);
          console.log(`[${traceId}] Meta-Daten in Storage gespeichert`);
          
          // Topic-Update asynchron im Hintergrund (nicht blockierend)
          setImmediate(async () => {
            try {
              const topicText = `Whitelist-Ticket ${meta.caseId} | Status: ${meta.status} | Bewerber: ${meta.applicantDiscordId ? `<@${meta.applicantDiscordId}>` : 'Unbekannt'}`;
              await interaction.channel.setTopic(topicText);
              console.log(`[${traceId}] Topic asynchron aktualisiert`);
            } catch (topicError) {
              console.warn(`[${traceId}] Topic-Update fehlgeschlagen:`, topicError);
            }
          });
          
          console.log(`[${traceId}] Meta-Daten aktualisiert`);
          
          // Ephemere Bestätigung
          console.log(`[${traceId}] Sende ephemere Bestätigung...`);
          try {
            if (interaction.deferred) {
              await interaction.editReply({ 
                content: `✅ Channel erfolgreich umbenannt zu: **${sanitized}**` 
              });
            } else {
              await interaction.reply({ 
                content: `✅ Channel erfolgreich umbenannt zu: **${sanitized}**`, 
                flags: 64 
              });
            }
            console.log(`[${traceId}] Ephemere Bestätigung gesendet`);
          } catch (replyError) {
            console.error(`[${traceId}] Reply-Fehler bei Bestätigung:`, replyError);
          }
          
          // Channel-Nachricht - Premium Design (asynchron im Hintergrund)
          console.log(`[${traceId}] Sende Channel-Nachricht...`);
          setImmediate(async () => {
            try {
              const renameEmbed = new EmbedBuilder()
                .setColor(0xFFA500) // Orange für Umbenennung
                .setTitle('✏️ Channel umbenannt')
                .setDescription([
                  `<@${interaction.user.id}> hat den Channel umbenannt.`,
                  '',
                  `**Neuer Name:** \`${sanitized}\``,
                  `**Alter Name:** \`${oldName}\``,
                  '',
                  '💡 *Der Channel wurde für bessere Organisation umbenannt.*'
                ].join('\n'))
                .setFooter({ text: `${meta.caseId} • Channel-Update` })
                .setTimestamp();
                
              const result = await safeChannelSend(interaction.channel, interaction.guild, { embeds: [renameEmbed] }, traceId);
              if (result.ok) {
                console.log(`[${traceId}] Channel-Nachricht für Umbenennung erfolgreich gesendet`);
              } else {
                console.warn(`[${traceId}] Konnte keine Channel-Nachricht senden:`, result.reason);
              }
            } catch (channelError) {
              console.error(`[${traceId}] Fehler beim Senden der Channel-Nachricht für Umbenennung:`, channelError);
            }
          });
          
          console.log(`[${traceId}] Modal-Verarbeitung erfolgreich abgeschlossen`);
          
        } catch (error) {
          console.error(`[${traceId}] Fehler beim Umbenennen:`, error);
          await interaction.editReply({ content: '❌ Fehler beim Umbenennen des Channels.' });
        }
        return;
      }
    }

  } catch (error) {
    console.error(`[${traceId}] Unerwarteter Fehler:`, error);
    
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: '❌ Ein unerwarteter Fehler ist aufgetreten.', flags: 64 });
      } catch (replyError) {
        console.error(`[${traceId}] Reply-Fehler:`, replyError);
      }
    } else if (interaction.deferred) {
      try {
        await interaction.editReply({ content: '❌ Ein unerwarteter Fehler ist aufgetreten.' });
      } catch (editError) {
        console.error(`[${traceId}] Edit-Fehler:`, editError);
      }
    }
  } finally {
    const duration = Date.now() - startTime;
    console.log(`[${traceId}] Abgeschlossen in ${duration}ms`);
  }
});

/* ===========================
   EXPRESS SERVER & HMAC
   =========================== */
const app = express();

// Static assets (for logo/banner)
try {
  app.use('/assets', express.static('assets'));
  console.log('🖼️ Static assets route enabled at /assets');
} catch {}

app.get('/health', (_req, res) => res.send('StarCity Bot alive'));
app.get('/version', (_req, res) => res.json({ version: STARSTYLE_VERSION }));

// Rohe JSON-Daten (für HMAC)
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
  const traceId = `webhook-${Date.now()}`;
  console.log(`[${traceId}] Webhook-Anfrage erhalten`);
  
  let key = null; // Variable außerhalb des try-catch definieren
  
  try {
    const sig = req.headers['x-signature'];
    if (!isValidSignature(req.rawBody, sig, process.env.WEBHOOK_SECRET)) {
      console.log(`[${traceId}] Ungültige Signatur`);
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }

    const {
      discordId, discordTag, charName, steamHex, alter,
      erfahrung, howFound, motivation, deskItem,
      timezone, websiteTicketId, answers,
    } = req.body;

    if (!charName) {
      console.log(`[${traceId}] charName fehlt`);
      return res.status(400).json({ ok: false, error: 'charName required' });
    }

    key = idempotency.createKey('webhook', websiteTicketId || discordId, discordId, charName);
    
    // Idempotenz prüfen
    const check = idempotency.isAllowed(key);
    if (!check.allowed) {
      console.log(`[${traceId}] Idempotenz-Prüfung fehlgeschlagen: ${check.reason}`);
      return res.status(409).json({ 
        ok: false, 
        error: check.reason === 'inflight' ? 'Ticket wird bereits erstellt' : 'Zu viele Tickets in kurzer Zeit' 
      });
    }

    console.log(`[${traceId}] Ticket-Channel wird erstellt`);
    const { channel, caseId } = await createTicketChannel({
      guildId: STARCITY_CONFIG.guildId,
      categoryId: STARCITY_CONFIG.categoryId,
      staffRoleId: null, // Nicht mehr benötigt, da hardcoded
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

    console.log(`[${traceId}] Ticket erfolgreich erstellt`);
    
    return res.json({ 
      ok: true, 
      caseId, 
      channelId: channel.id, 
      url: `https://discord.com/channels/${STARCITY_CONFIG.guildId}/${channel.id}` 
    });
    
  } catch (error) {
    console.error(`[${traceId}] Webhook-Fehler:`, error);
    return res.status(500).json({ ok: false, error: 'server error' });
  } finally {
    if (key) {
      idempotency.markComplete(key);
    }
  }
});

/* ===========================
   START
   =========================== */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`🌐 Webhook-Server läuft auf Port ${PORT}`);
});

// Keepalive: alle 4 Minuten /health pingen, damit Koyeb nicht einschläft
try {
  const SELF_URL = process.env.SELF_URL; // z.B. https://<app-name>-<id>.koyeb.app
  if (SELF_URL) {
    setInterval(() => {
      fetch(`${SELF_URL}/health`).catch(() => {});
    }, 240000);
    console.log('🔁 Keepalive aktiviert');
  } else {
    console.log('ℹ️ Kein SELF_URL gesetzt. Keepalive deaktiviert.');
  }
} catch {}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutdown signal empfangen...');
  idempotency.destroy();
  ticketMetaStorage.meta.clear();
  process.exit(0);
});
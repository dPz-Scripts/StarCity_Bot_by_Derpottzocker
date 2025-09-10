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

const BRAND = {
  name: process.env.BRAND_NAME || 'StarCity || Beta-Whitelist OPEN',
  color: parseInt((process.env.BRAND_COLOR || '00A2FF').replace('#', ''), 16),
  icon: process.env.BRAND_ICON_URL || null,
  banner: process.env.BRAND_BANNER_URL || null,
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
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
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = (await client.application.fetch()).id;
  
  // ZUERST alle alten Commands löschen
  await rest.put(Routes.applicationGuildCommands(appId, process.env.GUILD_ID), { body: [] });
  console.log('🗑️ Alte Slash-Commands gelöscht');
  
  // Dann neue Commands registrieren
  await rest.put(Routes.applicationGuildCommands(appId, process.env.GUILD_ID), { body: commands });
  console.log('✅ Neue Slash-Commands registriert');
}

/* ===========================
   BERECHTIGUNGEN
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
    );
    
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_rename')
        .setLabel('Umbenennen')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(false)
    );
  }
  
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Schließen')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed)
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
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    if (applicantId) {
      await channel.permissionOverwrites.edit(applicantId, { SendMessages: false });
    }
    if (!channel.name.startsWith('closed-')) {
      await channel.setName(`closed-${channel.name}`);
    }
    console.log(`Channel ${channel.id} erfolgreich gesperrt`);
  } catch (error) {
    console.error(`Fehler beim Sperren des Channels ${channel.id}:`, error);
    throw error; // Fehler weiterwerfen für bessere Behandlung
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
    
    // Verwende einen benutzerfreundlichen Topic-Text anstatt JSON
    const topicText = `Whitelist-Ticket ${meta.caseId} | Status: ${meta.status} | Bewerber: ${meta.applicantDiscordId ? `<@${meta.applicantDiscordId}>` : 'Unbekannt'}`;
    await channel.setTopic(topicText);
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

  // Berechtigungsüberschreibungen
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
  ];
  
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

  // Verbessertes Embed-Design
  const embed = new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle('Whitelist-Ticket erstellt')
    .setDescription([
      'Willkommen bei StarCity.',
      'Ihre Bewerbung ist eingegangen. Unser Team meldet sich zeitnah.',
      '',
      'Bitte halten Sie die Kommunikation in diesem Ticket gebündelt.',
    ].join('\n'))
    .setFooter({ text: `${caseId} • Status: Offen` })
    .setTimestamp();

  if (BRAND.icon) {
    embed.setAuthor({ name: BRAND.name, iconURL: BRAND.icon });
    embed.setThumbnail(BRAND.icon);
  } else {
    embed.setAuthor({ name: BRAND.name });
  }
  
  if (BRAND.banner) {
    embed.setImage(BRAND.banner);
  }

  const bewerberText = applicantDiscordId ? `<@${applicantDiscordId}> (${clean(form.discordTag || applicantTag)})` : clean(form.discordTag || applicantTag);

  // Verbesserte Feld-Darstellung
  embed.addFields(
    { name: 'Bewerber', value: trunc(bewerberText, 256), inline: false },
    { name: 'Charakter', value: trunc(form.charName, 128) || '—', inline: true },
    { name: 'Alter', value: form.alter ? String(form.alter) : '—', inline: true },
    { name: 'Steam Hex', value: trunc(form.steamHex, 64) || '—', inline: true },
    { name: 'Discord', value: trunc(form.discordTag, 128) || '—', inline: true },
    { name: 'Zeitzone', value: trunc(form.timezone, 64) || '—', inline: true },
  );

  if (form.howFound) {
    embed.addFields({ name: 'Wie gefunden', value: trunc(form.howFound, 1024), inline: false });
  }
  
  if (form.deskItem) {
    embed.addFields({ name: 'Hinweis', value: trunc(form.deskItem, 1024), inline: false });
  }

  const qa = normalizeAnswers(form.answers);
  for (let i = 0; i < qa.length && i < 10; i++) {
    embed.addFields({ 
      name: `Frage ${i + 1}: ${trunc(qa[i].q, 200)}`, 
      value: trunc(qa[i].a, 1024), 
      inline: false 
    });
  }

  const sent = await channel.send({
    content: `<@&${process.env.STAFF_ROLE_ID}> Neues Whitelist-Ticket`,
    embeds: [embed],
    components: [buildTicketButtons()],
    allowedMentions: { roles: [process.env.STAFF_ROLE_ID] },
  });

  meta.originalMessageId = sent.id;
  await writeTicketMeta(channel, meta);

  return { channel, caseId, messageId: sent.id };
}

/* ===========================
   INTERAKTIONEN (SLASH + BUTTONS) - NEU
   =========================== */
client.on('interactionCreate', async (interaction) => {
  const traceId = interaction.id;
  const startTime = Date.now();
  
  console.log(`[${traceId}] ${interaction.type} by ${interaction.user?.tag || interaction.user?.id}`);

  // SOFORT antworten für alle Interaktionen um Timeout zu vermeiden
  let deferred = false;
  try {
    if (interaction.isChatInputCommand() || interaction.isButton()) {
      await interaction.deferReply({ flags: 64 });
      deferred = true;
      console.log(`[${traceId}] DeferReply erfolgreich`);
    }
  } catch (deferError) {
    console.error(`[${traceId}] DeferReply-Fehler:`, deferError);
    // Versuche trotzdem zu antworten
  }

  try {
    // SLASH COMMANDS
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'ticket-test') return;
      
      const charName = interaction.options.getString('charname', true);
      const key = idempotency.createKey('slash', process.env.GUILD_ID, interaction.user.id, charName);
      
      // Idempotenz prüfen
      const check = idempotency.isAllowed(key);
      if (!check.allowed) {
        const message = check.reason === 'inflight' 
          ? '⏳ Ticket wird bereits erstellt...' 
          : `⏳ Zu viele Tickets in kurzer Zeit. Bitte warte ${check.age || 60} Sekunden.`;
        
        if (deferred) {
          await interaction.editReply({ content: message });
        } else {
          await interaction.reply({ content: message, flags: 64 });
        }
        return;
      }

      try {
        const { channel } = await createTicketChannel({
          guildId: process.env.GUILD_ID,
          categoryId: process.env.TICKETS_CATEGORY_ID,
          staffRoleId: process.env.STAFF_ROLE_ID,
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
          content: `✅ Ticket erfolgreich erstellt: https://discord.com/channels/${process.env.GUILD_ID}/${channel.id}` 
        });
        
      } catch (error) {
        console.error(`[${traceId}] Ticket-Erstellung fehlgeschlagen:`, error);
        await interaction.editReply({ content: '❌ Fehler beim Erstellen des Tickets. Bitte versuche es erneut.' });
      } finally {
        idempotency.markComplete(key);
      }
      
      return;
    }

    // BUTTON INTERACTIONS
    if (interaction.isButton()) {
      console.log(`[${traceId}] Button-Klick: ${interaction.customId}`);
      
      const staffRoleId = process.env.STAFF_ROLE_ID;
      if (!staffRoleId) {
        console.log(`[${traceId}] STAFF_ROLE_ID nicht konfiguriert`);
        if (deferred) {
          await interaction.editReply({ content: '⚠️ STAFF_ROLE_ID nicht konfiguriert.' });
        } else {
          await interaction.reply({ content: '⚠️ STAFF_ROLE_ID nicht konfiguriert.', flags: 64 });
        }
        return;
      }

      const isStaff = interaction.member?.roles?.cache?.has?.(staffRoleId) || false;
      console.log(`[${traceId}] Staff-Check: ${isStaff} (Role: ${staffRoleId})`);
      if (!isStaff) {
        if (deferred) {
          await interaction.editReply({ content: '❌ Nur Staff-Mitglieder können diese Aktion ausführen.' });
        } else {
          await interaction.reply({ content: '❌ Nur Staff-Mitglieder können diese Aktion ausführen.', flags: 64 });
        }
        return;
      }

      const channel = interaction.channel;
      const meta = readTicketMeta(channel);
      console.log(`[${traceId}] Meta-Daten:`, meta);
      
      if (!meta.caseId) {
        console.log(`[${traceId}] Kein gültiges Ticket (kein caseId)`);
        if (deferred) {
          await interaction.editReply({ content: '❌ Dies ist kein gültiges Ticket.' });
        } else {
          await interaction.reply({ content: '❌ Dies ist kein gültiges Ticket.', flags: 64 });
        }
        return;
      }

      // Berechtigungen prüfen
      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms?.has(PermissionFlagsBits.ManageChannels)) {
        console.log(`[${traceId}] Fehlende ManageChannels-Berechtigung`);
        if (deferred) {
          await interaction.editReply({ content: '❌ Mir fehlen die nötigen Berechtigungen.' });
        } else {
          await interaction.reply({ content: '❌ Mir fehlen die nötigen Berechtigungen.', flags: 64 });
        }
        return;
      }

      if (interaction.customId === 'ticket_claim') {
        console.log(`[${traceId}] Verarbeite Ticket-Übernahme`);
        if (meta.claimedBy) {
          if (deferred) {
            await interaction.editReply({ content: '⚠️ Dieses Ticket wurde bereits übernommen.' });
          } else {
            await interaction.reply({ content: '⚠️ Dieses Ticket wurde bereits übernommen.', flags: 64 });
          }
          return;
        }

        // Ephemere Bestätigung
        if (deferred) {
          await interaction.editReply({ content: '✅ Ticket erfolgreich übernommen!' });
        } else {
          await interaction.reply({ content: '✅ Ticket erfolgreich übernommen!', flags: 64 });
        }

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

          // Channel-Nachricht (robust)
          console.log(`[${traceId}] Sende Channel-Nachricht`);
          {
            const msg = `✅ **Ticket übernommen**\n\n<@${interaction.user.id}> hat das Ticket übernommen.\nEs wird sich nun um deine Angelegenheiten gekümmert. Habe jedoch Geduld, wenn dir nicht immer sofort geantwortet wird.`;
            const result = await safeChannelSend(channel, interaction.guild, msg, traceId);
            if (!result.ok) {
              console.warn(`[${traceId}] Konnte keine Channel-Nachricht senden:`, result.reason);
            }
          }
          
          return;
        }

      if (interaction.customId === 'ticket_close') {
        console.log(`[${traceId}] Verarbeite Ticket-Schließung`);
        
        // Ephemere Bestätigung
        if (deferred) {
          await interaction.editReply({ content: '🔒 Ticket erfolgreich geschlossen!' });
        } else {
          await interaction.reply({ content: '🔒 Ticket erfolgreich geschlossen!', flags: 64 });
        }

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

          // Channel-Nachricht (vor dem Sperren senden)
          console.log(`[${traceId}] Sende Channel-Nachricht`);
          {
            const msg = `🔒 **Ticket geschlossen**\n\n<@${interaction.user.id}> hat das Ticket geschlossen.\nVielen Dank für deine Bewerbung bei StarCity!`;
            const result = await safeChannelSend(channel, interaction.guild, msg, traceId);
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
          
          return;
        }

      if (interaction.customId === 'ticket_rename') {
        console.log(`[${traceId}] Verarbeite Ticket-Umbenennung`);
        
        // Modal für neue Channel-Namen erstellen
        const modal = new ModalBuilder()
          .setCustomId('ticket_rename_modal')
          .setTitle('Ticket umbenennen');

        const nameInput = new TextInputBuilder()
          .setCustomId('new_channel_name')
          .setLabel('Neuer Channel-Name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('z.B. whitelist-max-mustermann-1234')
          .setValue(channel.name)
          .setRequired(true)
          .setMaxLength(100);

        const actionRow = new ActionRowBuilder().addComponents(nameInput);
        modal.addComponents(actionRow);

        // Modal anzeigen (ohne deferReply für Modals)
        await interaction.showModal(modal);
        return;
      }

      console.log(`[${traceId}] Unbekannter Button: ${interaction.customId}`);
      if (deferred) {
        await interaction.editReply({ content: '❌ Unbekannte Aktion.' });
      } else {
        await interaction.reply({ content: '❌ Unbekannte Aktion.', flags: 64 });
      }
    }

    // MODAL SUBMITS
    if (interaction.isModalSubmit()) {
      console.log(`[${traceId}] Modal-Submit: ${interaction.customId}`);
      
      if (interaction.customId === 'ticket_rename_modal') {
        console.log(`[${traceId}] Starte Modal-Verarbeitung`);
        
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

          // Channel umbenennen
          console.log(`[${traceId}] Starte Channel-Umbenennung...`);
          await interaction.channel.setName(sanitized);
          console.log(`[${traceId}] Channel erfolgreich umbenannt zu: ${sanitized}`);
          
          // Meta aktualisieren
          console.log(`[${traceId}] Aktualisiere Meta-Daten...`);
          const meta = readTicketMeta(interaction.channel);
          meta.renamedBy = interaction.user.id;
          meta.renamedAt = Date.now();
          meta.originalName = oldName;
          await writeTicketMeta(interaction.channel, meta);
          console.log(`[${traceId}] Meta-Daten aktualisiert`);
          
          // Ephemere Bestätigung
          console.log(`[${traceId}] Sende ephemere Bestätigung...`);
          if (deferred) {
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
          
          // Channel-Nachricht
          console.log(`[${traceId}] Sende Channel-Nachricht...`);
          try {
            const msg = `✏️ **Channel umbenannt**\n<@${interaction.user.id}> hat den Channel zu **${sanitized}** umbenannt.`;
            const result = await safeChannelSend(interaction.channel, interaction.guild, msg, traceId);
            if (result.ok) {
              console.log(`[${traceId}] Channel-Nachricht für Umbenennung erfolgreich gesendet`);
            } else {
              console.warn(`[${traceId}] Konnte keine Channel-Nachricht senden:`, result.reason);
            }
          } catch (channelError) {
            console.error(`[${traceId}] Fehler beim Senden der Channel-Nachricht für Umbenennung:`, channelError);
          }
          
          console.log(`[${traceId}] Modal-Verarbeitung erfolgreich abgeschlossen`);
          
        } catch (error) {
          console.error(`[${traceId}] Fehler beim Umbenennen:`, error);
          if (deferred) {
            await interaction.editReply({ content: '❌ Fehler beim Umbenennen des Channels.' });
          } else {
            await interaction.reply({ content: '❌ Fehler beim Umbenennen des Channels.', flags: 64 });
          }
        }
        return;
      }
    }

  } catch (error) {
    console.error(`[${traceId}] Unerwarteter Fehler:`, error);
    
    if (deferred) {
      try {
        await interaction.editReply({ content: '❌ Ein unerwarteter Fehler ist aufgetreten.' });
      } catch (editError) {
        console.error(`[${traceId}] Edit-Fehler:`, editError);
      }
    } else if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: '❌ Ein unerwarteter Fehler ist aufgetreten.', flags: 64 });
      } catch (replyError) {
        console.error(`[${traceId}] Reply-Fehler:`, replyError);
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

    const key = idempotency.createKey('webhook', websiteTicketId || discordId, discordId, charName);
    
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

    console.log(`[${traceId}] Ticket erfolgreich erstellt`);
    
    return res.json({ 
      ok: true, 
      caseId, 
      channelId: channel.id, 
      url: `https://discord.com/channels/${process.env.GUILD_ID}/${channel.id}` 
    });
    
  } catch (error) {
    console.error(`[${traceId}] Webhook-Fehler:`, error);
    return res.status(500).json({ ok: false, error: 'server error' });
  } finally {
    idempotency.markComplete(key);
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
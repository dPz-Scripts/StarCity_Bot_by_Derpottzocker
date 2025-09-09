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
        .setEmoji(claimed ? '✅' : '👋')
        .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(claimed)
    );
    
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_rename')
        .setLabel('Umbenennen')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(closed)
    );
  }
  
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Schließen')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed)
  );
  
  return row;
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
    return JSON.parse(channel.topic || '{}');
  } catch {
    return {};
  }
}

async function writeTicketMeta(channel, meta) {
  try {
    console.log(`Schreibe Meta-Daten für Channel ${channel.id}:`, meta);
    await channel.setTopic(JSON.stringify(meta));
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
    .setTitle('🎫 Whitelist-Ticket eröffnet')
    .setDescription([
      '**Willkommen bei StarCity!**',
      '',
      'Deine Bewerbung wurde erfolgreich eingereicht. Unser Team wird sich zeitnah bei dir melden.',
      '',
      '**Bitte bleib in diesem Ticket und warte auf eine Antwort.**',
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
    { name: '👤 Bewerber', value: trunc(bewerberText, 256), inline: false },
    { name: '🎭 Charakter', value: trunc(form.charName, 128) || '—', inline: true },
    { name: '🎂 Alter', value: form.alter ? String(form.alter) : '—', inline: true },
    { name: '🆔 Steam Hex', value: trunc(form.steamHex, 64) || '—', inline: true },
    { name: '💬 Discord', value: trunc(form.discordTag, 128) || '—', inline: true },
    { name: '🌍 Zeitzone', value: trunc(form.timezone, 64) || '—', inline: true },
  );

  if (form.howFound) {
    embed.addFields({ name: '🔍 Wie gefunden', value: trunc(form.howFound, 1024), inline: false });
  }
  
  if (form.deskItem) {
    embed.addFields({ name: '🖥️ Schreibtisch-Item', value: trunc(form.deskItem, 1024), inline: false });
  }

  const qa = normalizeAnswers(form.answers);
  for (let i = 0; i < qa.length && i < 10; i++) {
    embed.addFields({ 
      name: `❓ Frage ${i + 1}: ${trunc(qa[i].q, 200)}`, 
      value: trunc(qa[i].a, 1024), 
      inline: false 
    });
  }

  const sent = await channel.send({
    content: `<@&${process.env.STAFF_ROLE_ID}> 🎫 Neues Whitelist-Ticket`,
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
        
        await interaction.reply({ content: message, flags: 64 });
        return;
      }

      // ACK senden
      await interaction.reply({ content: '⏳ Ticket wird erstellt...', flags: 64 });

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
      
      try {
        const staffRoleId = process.env.STAFF_ROLE_ID;
        if (!staffRoleId) {
          console.log(`[${traceId}] STAFF_ROLE_ID nicht konfiguriert`);
          await interaction.reply({ content: '⚠️ STAFF_ROLE_ID nicht konfiguriert.', flags: 64 });
          return;
        }

        const isStaff = interaction.member?.roles?.cache?.has?.(staffRoleId) || false;
        console.log(`[${traceId}] Staff-Check: ${isStaff} (Role: ${staffRoleId})`);
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

          // ZUERST ephemere Antwort senden
          console.log(`[${traceId}] Sende ephemere Bestätigung`);
          await interaction.reply({ content: '✅ Ticket erfolgreich übernommen!', flags: 64 });

          // Dann Buttons aktualisieren
          console.log(`[${traceId}] Aktualisiere Buttons`);
          try {
            await interaction.message.edit({ 
              components: [buildTicketButtons({ claimed: true, closed: false })] 
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
            console.log(`[${traceId}] Meta-Daten erfolgreich aktualisiert`);
          } catch (metaError) {
            console.error(`[${traceId}] Fehler beim Speichern der Meta-Daten:`, metaError);
          }

          // Channel-Nachricht
          console.log(`[${traceId}] Sende Channel-Nachricht`);
          try {
            const channelMessage = `✅ **Ticket übernommen**\n<@${interaction.user.id}> hat das Ticket übernommen und wird sich um deine Bewerbung kümmern.`;
            await channel.send(channelMessage);
            console.log(`[${traceId}] Channel-Nachricht erfolgreich gesendet: ${channelMessage}`);
          } catch (channelError) {
            console.error(`[${traceId}] Fehler beim Senden der Channel-Nachricht:`, channelError);
          }
          
          return;
        }

        if (interaction.customId === 'ticket_close') {
          console.log(`[${traceId}] Verarbeite Ticket-Schließung`);
          
          // ZUERST ephemere Antwort senden
          console.log(`[${traceId}] Sende ephemere Bestätigung`);
          await interaction.reply({ content: '🔒 Ticket erfolgreich geschlossen!', flags: 64 });

          // Dann Buttons aktualisieren
          console.log(`[${traceId}] Aktualisiere Buttons`);
          try {
            await interaction.message.edit({ 
              components: [buildTicketButtons({ claimed: !!meta.claimedBy, closed: true })] 
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
          } catch (metaError) {
            console.error(`[${traceId}] Fehler beim Speichern der Meta-Daten:`, metaError);
          }

          // Channel sperren
          console.log(`[${traceId}] Sperre Channel`);
          try {
            await lockChannel(channel, meta.applicantDiscordId);
            console.log(`[${traceId}] Channel erfolgreich gesperrt`);
          } catch (lockError) {
            console.error(`[${traceId}] Fehler beim Sperren des Channels:`, lockError);
          }

          // Channel-Nachricht
          console.log(`[${traceId}] Sende Channel-Nachricht`);
          try {
            const channelMessage = `🔒 **Ticket geschlossen**\n<@${interaction.user.id}> hat das Ticket geschlossen.`;
            await channel.send(channelMessage);
            console.log(`[${traceId}] Channel-Nachricht erfolgreich gesendet: ${channelMessage}`);
          } catch (channelError) {
            console.error(`[${traceId}] Fehler beim Senden der Channel-Nachricht:`, channelError);
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

          await interaction.showModal(modal);
          return;
        }

        console.log(`[${traceId}] Unbekannter Button: ${interaction.customId}`);
        await interaction.reply({ content: '❌ Unbekannte Aktion.', flags: 64 });
        
      } catch (buttonError) {
        console.error(`[${traceId}] Button-Fehler:`, buttonError);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Fehler bei der Button-Aktion.', flags: 64 });
        }
      }
    }

    // MODAL SUBMITS
    if (interaction.isModalSubmit()) {
      console.log(`[${traceId}] Modal-Submit: ${interaction.customId}`);
      
      if (interaction.customId === 'ticket_rename_modal') {
        try {
          const newName = interaction.fields.getTextInputValue('new_channel_name');
          console.log(`[${traceId}] Neuer Channel-Name: ${newName}`);
          
          // Channel umbenennen
          await interaction.channel.setName(newName);
          console.log(`[${traceId}] Channel erfolgreich umbenannt zu: ${newName}`);
          
          // Meta aktualisieren
          const meta = readTicketMeta(interaction.channel);
          meta.renamedBy = interaction.user.id;
          meta.renamedAt = Date.now();
          meta.originalName = interaction.channel.name;
          await writeTicketMeta(interaction.channel, meta);
          
          // Ephemere Bestätigung
          await interaction.reply({ 
            content: `✅ Channel erfolgreich umbenannt zu: **${newName}**`, 
            flags: 64 
          });
          
          // Channel-Nachricht
          await interaction.channel.send(`✏️ **Channel umbenannt**\n<@${interaction.user.id}> hat den Channel zu **${newName}** umbenannt.`);
          
        } catch (error) {
          console.error(`[${traceId}] Fehler beim Umbenennen:`, error);
          await interaction.reply({ 
            content: '❌ Fehler beim Umbenennen des Channels.', 
            flags: 64 
          });
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutdown signal empfangen...');
  idempotency.destroy();
  process.exit(0);
});
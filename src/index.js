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

// ---- DISCORD CLIENT ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // nützlich für Bewerberchecks
  ],
});

client.once('ready', async () => {
  console.log(`✅ Eingeloggt als ${client.user.tag}`);
  try {
    await registerSlashCommands();
    console.log('✅ Slash-Commands registriert');
  } catch (e) {
    console.error('❌ Slash-Command-Register-Fehler:', e);
  }
});

client.login(process.env.DISCORD_TOKEN);

// ---- SLASH COMMANDS REGISTRIEREN ----
async function registerSlashCommands() {
  const commands = [
    {
      name: 'ticket-test',
      description: 'Erstellt ein Test-Ticket (nur für dich und Staff sichtbar).',
      options: [
        {
          name: 'charname',
          description: 'RP-Name der Figur',
          type: 3, // STRING
          required: true,
        },
      ],
    },
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(
      (await client.application.fetch()).id,
      process.env.GUILD_ID
    ),
    { body: commands }
  );
}

// ---- PERMISSIONS-CHECK im (potenziellen) Parent ----
function hasNeededPermsIn(channelOrId) {
  try {
    const perms = client.guilds.cache
      .get(process.env.GUILD_ID)
      ?.members?.me?.permissionsIn(channelOrId);
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

// ---- HELFER: Ticket-Channel erstellen ----
async function createTicketChannel({
  guildId,
  categoryId,
  staffRoleId,
  applicantDiscordId,
  applicantTag = '—',
  charName,
  fields = {},
  websiteTicketId = null,
}) {
  const guild = await client.guilds.fetch(guildId);

  // Kategorie validieren & Berechtigungen prüfen
  let parent = undefined;
  if (categoryId) {
    const cat = await guild.channels.fetch(categoryId).catch(() => null);
    if (cat && cat.type === ChannelType.GuildCategory) {
      const check = hasNeededPermsIn(cat.id);
      if (check.ok) {
        parent = cat.id;
      } else {
        console.warn(
          `⚠️ Mir fehlen im Kategorie-Ordner Rechte: ${check.missing
            .map((m) => PermissionFlagsBits[m] ?? m)
            .join(', ')}. Erstelle Ticket OHNE Kategorie.`
        );
      }
    } else {
      console.warn('⚠️ TICKETS_CATEGORY_ID ist keine Kategorie. Erstelle ohne parent.');
    }
  }

  // Channelname
  const safeName = (charName || 'bewerber')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 20);
  const shortId = (websiteTicketId || applicantDiscordId || '0000')
    .toString()
    .slice(-4);
  const channelName = `whitelist-${safeName}-${shortId}`;

  // Rechte setzen (inkl. Bot selbst!)
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: staffRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  if (applicantDiscordId) {
    overwrites.push({
      id: applicantDiscordId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  // Channel erstellen
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
    console.error(
      '❌ Erstellen des Channels fehlgeschlagen:',
      e?.code,
      e?.message
    );
    throw e;
  }

  // Embed bauen
  const embed = new EmbedBuilder()
    .setTitle('📝 Whitelist-Bewerbung')
    .setDescription('Bitte prüfen und Rückmeldung geben.')
    .addFields(
      {
        name: 'Bewerber',
        value: applicantDiscordId
          ? `<@${applicantDiscordId}> (${applicantTag})`
          : applicantTag,
        inline: false,
      },
      { name: 'Charakter', value: charName || '—', inline: true },
      ...(fields.steamHex
        ? [{ name: 'Steam Hex', value: fields.steamHex, inline: true }]
        : []),
      ...(fields.alter
        ? [{ name: 'Alter', value: String(fields.alter), inline: true }]
        : []),
      ...(fields.timezone
        ? [{ name: 'Zeitzone', value: fields.timezone, inline: true }]
        : []),
      ...(fields.erfahrung
        ? [{ name: 'Erfahrung', value: fields.erfahrung, inline: false }]
        : []),
      ...(fields.motivation
        ? [{ name: 'Motivation', value: fields.motivation, inline: false }]
        : [])
    )
    .setFooter({ text: `Ticket-ID: ${websiteTicketId || '—'}` })
    .setTimestamp();

  // Nachricht senden (Rollen-Ping explizit erlauben)
  await channel.send({
    content: `<@&${staffRoleId}> Neues Ticket eingegangen.`,
    embeds: [embed],
    allowedMentions: { roles: [staffRoleId] },
  });

  return channel;
}

// ---- SLASH COMMAND HANDLER ----
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ticket-test') {
    const charName = interaction.options.getString('charname', true);

    // Ephemeral (nur für dich sichtbar) – neues Schema mit flags: 64
    try {
      await interaction.deferReply({ flags: 64 }); // 64 = EPHEMERAL
    } catch {
      // Fallback: falls defer nicht geht, sofort antworten
      if (!interaction.replied) {
        await interaction.reply({ content: '⏳ Erstelle Ticket…', flags: 64 });
      }
    }

    try {
      const channel = await createTicketChannel({
        guildId: process.env.GUILD_ID,
        categoryId: process.env.TICKETS_CATEGORY_ID,
        staffRoleId: process.env.STAFF_ROLE_ID,
        applicantDiscordId: interaction.user.id,
        applicantTag: `${interaction.user.username}`,
        charName,
        fields: {
          timezone: 'Europe/Berlin',
        },
      });

      const msg = `✅ Ticket erstellt: https://discord.com/channels/${process.env.GUILD_ID}/${channel.id}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg });
      } else {
        await interaction.reply({ content: msg, flags: 64 });
      }
    } catch (e) {
      console.error('❌ Ticket-Fehler:', e?.code, e?.message);
      const errTxt =
        '❌ Konnte Ticket nicht erstellen. Prüfe Rechte & IDs.\n' +
        '• Hat der Bot im Kategorie-Ordner **Manage Channels** + **View Channel**?\n' +
        '• Ist `TICKETS_CATEGORY_ID` wirklich eine **Kategorie**?\n' +
        '• Stimmt `STAFF_ROLE_ID` (existiert auf DIESEM Server)?';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errTxt });
      } else {
        await interaction.reply({ content: errTxt, flags: 64 });
      }
    }
  }
});

// ---- MINI-WEBSERVER FÜR WEBSITE ----
const app = express();

// Roh-Body + JSON parsen (für HMAC)
app.use((req, res, next) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    try {
      req.body = JSON.parse(req.rawBody.toString('utf8') || '{}');
    } catch {
      req.body = {};
    }
    next();
  });
});

function isValidSignature(rawBody, signatureHex, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const digest = hmac.digest('hex');
  if (!signatureHex) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'hex'),
      Buffer.from(signatureHex, 'hex')
    );
  } catch {
    return false;
  }
}

// POST /whitelist -> von Website
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
      erfahrung,
      motivation,
      timezone,
      websiteTicketId,
    } = req.body;

    if (!charName)
      return res.status(400).json({ ok: false, error: 'charName required' });

    const channel = await createTicketChannel({
      guildId: process.env.GUILD_ID,
      categoryId: process.env.TICKETS_CATEGORY_ID,
      staffRoleId: process.env.STAFF_ROLE_ID,
      applicantDiscordId: discordId,
      applicantTag: discordTag,
      charName,
      websiteTicketId,
      fields: { steamHex, alter, erfahrung, motivation, timezone },
    });

    return res.json({
      ok: true,
      channelId: channel.id,
      url: `https://discord.com/channels/${process.env.GUILD_ID}/${channel.id}`,
    });
  } catch (e) {
    console.error('❌ /whitelist Fehler:', e?.code, e?.message);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`🌐 Webhook-Server läuft auf Port ${process.env.PORT}`);
});

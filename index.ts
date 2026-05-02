import { api, opendiscord, utilities } from "#opendiscord"
import * as discord from "discord.js"
import * as mysql from "mysql2/promise"
import * as fs from "fs"
import * as path from "path"

if (utilities.project != "openticket")
    throw new api.ODPluginError("This plugin only works in Open Ticket!")

declare module "#opendiscord-types" {
    export interface ODPluginManagerIds_Default {
        "litebans-integration": api.ODPlugin
    }
}

// ─── Read config directly from disk ──────────────────────────────────────────
// Previous versions used OT's config API (ODJsonConfig) but cfg.data was always
// empty because OT parses plugin-registered configs AFTER all lifecycle events
// fire. Reading the file synchronously with fs bypasses this entirely.
interface PluginConfig {
    mysql: { host: string; port: number; user: string; password: string; database: string }
    tablePrefix: string
    roles: { ban: string[]; mute: string[]; warn: string[]; lookup: string[] }
    ticketHistoryTriggers: string[]
    historyEmbed: { color: string; maxEntriesPerType: number }
    logChannelId: string
}

function loadConfig(): PluginConfig | null {
    const filePath = path.resolve("./plugins/litebans-integration/config.json")
    try {
        const raw    = fs.readFileSync(filePath, "utf-8")
        const parsed = JSON.parse(raw) as PluginConfig
        if (!parsed?.mysql?.host) {
            opendiscord.log("LiteBans Integration: config.json is missing `mysql.host`.", "error")
            return null
        }
        return parsed
    } catch (err: any) {
        opendiscord.log(`LiteBans Integration: cannot read config.json – ${err.message}`, "error")
        return null
    }
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────
function getInteraction(instance: any): discord.ChatInputCommandInteraction {
    return instance.interaction as discord.ChatInputCommandInteraction
}

function parseDuration(raw: string): number {
    const s = raw.trim().toLowerCase()
    if (s === "perm" || s === "permanent" || s === "-1") return -1
    const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/)
    if (!match) throw new Error(`Invalid duration: "${raw}". Use e.g. 7d, 2h, 30m, perm.`)
    const n = parseFloat(match[1]), unit = match[2], MS = 1000
    if (unit.startsWith("s"))                           return Math.round(n * MS)
    if (unit.startsWith("m") && !unit.startsWith("mo")) return Math.round(n * 60 * MS)
    if (unit.startsWith("h"))                           return Math.round(n * 3600 * MS)
    if (unit.startsWith("d"))                           return Math.round(n * 86400 * MS)
    if (unit.startsWith("w"))                           return Math.round(n * 7 * 86400 * MS)
    if (unit.startsWith("mo"))                          return Math.round(n * 30 * 86400 * MS)
    if (unit.startsWith("y"))                           return Math.round(n * 365 * 86400 * MS)
    throw new Error(`Unknown unit: "${raw}"`)
}

function formatDuration(ms: number): string {
    if (ms < 0) return "Permanent"
    const s = Math.floor(ms / 1000);  if (s  < 60)  return `${s}s`
    const m = Math.floor(s / 60);     if (m  < 60)  return `${m}m`
    const h = Math.floor(m / 60);     if (h  < 24)  return `${h}h`
    const d = Math.floor(h / 24);     if (d  < 30)  return `${d}d`
    const mo = Math.floor(d / 30);    if (mo < 12)  return `${mo}mo`
    return `${Math.floor(mo / 12)}y`
}

async function resolveUUID(pool: mysql.Pool, prefix: string, name: string): Promise<string | null> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT uuid FROM \`${prefix}history\` WHERE LOWER(name)=LOWER(?) ORDER BY id DESC LIMIT 1`, [name]
    )
    if (rows.length > 0 && rows[0].uuid) return rows[0].uuid as string
    try {
        const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`)
        if (res.ok) {
            const d = await res.json() as { id: string }
            return `${d.id.slice(0,8)}-${d.id.slice(8,12)}-${d.id.slice(12,16)}-${d.id.slice(16,20)}-${d.id.slice(20)}`
        }
    } catch { /* fall through */ }
    return null
}

async function buildHistoryEmbed(pool: mysql.Pool, prefix: string, playerName: string, uuid: string | null, color: string, max: number): Promise<discord.EmbedBuilder> {
    const embed = new discord.EmbedBuilder().setTitle(`📋 Punishment History – ${playerName}`).setColor(color as discord.ColorResolvable).setTimestamp()
    if (!uuid) { embed.setDescription("⚠️ Player not found in LiteBans or Mojang API. They may never have joined the server."); return embed }

    const q = async (table: string) => {
        const [r] = await pool.query<mysql.RowDataPacket[]>(
            `SELECT reason,banned_by_name,time,until,active FROM \`${prefix}${table}\` WHERE uuid=? OR uuid=? ORDER BY time DESC LIMIT ?`,
            [uuid, uuid.replace(/-/g,""), max]
        )
        return r
    }

    const bans = await q("bans")
    embed.addFields({ name: "🔨 Bans", value: bans.length ? bans.map(r => `${r.active?"🔴":"⚫"} **${r.reason??"No reason"}** | \`${r.banned_by_name}\` | ${new Date(Number(r.time)).toLocaleDateString("en-GB")} | ${Number(r.until)<0?"Permanent":formatDuration(Number(r.until)-Number(r.time))}`).join("\n").slice(0,1024) : "*None*" })
    const mutes = await q("mutes")
    embed.addFields({ name: "🔇 Mutes", value: mutes.length ? mutes.map(r => `${r.active?"🔴":"⚫"} **${r.reason??"No reason"}** | \`${r.banned_by_name}\` | ${new Date(Number(r.time)).toLocaleDateString("en-GB")} | ${Number(r.until)<0?"Permanent":formatDuration(Number(r.until)-Number(r.time))}`).join("\n").slice(0,1024) : "*None*" })
    const warns = await q("warnings")
    embed.addFields({ name: "⚠️ Warnings", value: warns.length ? warns.map(r => `${r.active?"🟡":"⚫"} **${r.reason??"No reason"}** | \`${r.banned_by_name}\` | ${new Date(Number(r.time)).toLocaleDateString("en-GB")}`).join("\n").slice(0,1024) : "*None*" })
    const [kicks] = await pool.query<mysql.RowDataPacket[]>(`SELECT reason,banned_by_name,time FROM \`${prefix}kicks\` WHERE uuid=? OR uuid=? ORDER BY time DESC LIMIT ?`,[uuid,uuid.replace(/-/g,""),max])
    embed.addFields({ name: "👢 Kicks", value: (kicks as mysql.RowDataPacket[]).length ? (kicks as mysql.RowDataPacket[]).map(r=>`👢 **${r.reason??"No reason"}** | \`${r.banned_by_name}\` | ${new Date(Number(r.time)).toLocaleDateString("en-GB")}`).join("\n").slice(0,1024) : "*None*" })
    embed.setFooter({ text: `UUID: ${uuid}` })
    return embed
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
opendiscord.events.get("onConfigLoad")!.listen(async () => {
    const config = loadConfig()
    if (!config) return

    const { host, port, user, password, database } = config.mysql
    const prefix   = config.tablePrefix              ?? "litebans_"
    const triggers = config.ticketHistoryTriggers    ?? []
    const color    = config.historyEmbed?.color      ?? "#e74c3c"
    const maxRows  = config.historyEmbed?.maxEntriesPerType ?? 5
    const roles    = config.roles ?? { ban: [], mute: [], warn: [], lookup: [] }
    const logChannelId = config.logChannelId ?? ""

    opendiscord.log(`LiteBans Integration: config loaded (host=${host}, db=${database})`, "plugin")

    // MySQL pool
    let pool: mysql.Pool | null = null
    try {
        pool = mysql.createPool({ host, port, user, password, database, waitForConnections: true, connectionLimit: 5 })
        const c = await pool.getConnection(); c.release()
        opendiscord.log(`LiteBans Integration: MySQL connected → ${host}:${port}/${database}`, "plugin")
    } catch (err: any) {
        opendiscord.log(`LiteBans Integration: MySQL FAILED – ${err.message}`, "error")
    }

    // Permission check
    async function hasRole(ids: string[], instance: any, cancel: () => void): Promise<boolean> {
        const member = instance.member as discord.GuildMember | null
        if (!member || !instance.guild) { await getInteraction(instance).reply({ content: "❌ Server only.", ephemeral: true }); cancel(); return false }
        if (!ids?.length) { await getInteraction(instance).reply({ content: "❌ No roles configured for this command in config.json.", ephemeral: true }); cancel(); return false }
        if (!ids.some(id => member.roles.cache.has(id))) {
            await getInteraction(instance).reply({ content: `❌ Missing permission. Required: ${ids.map(id=>`<@&${id}>`).join(", ")}`, ephemeral: true })
            cancel(); return false
        }
        return true
    }

    async function err(instance: any, msg: string) {
        const ix = getInteraction(instance)
        if (ix.deferred || ix.replied) await ix.editReply({ content: msg })
        else await ix.reply({ content: msg, ephemeral: true })
    }

    const ok = (title: string, fields: { name: string; value: string; inline?: boolean }[], color: discord.ColorResolvable = 0x2ecc71) =>
        new discord.EmbedBuilder().setTitle(title).setColor(color).addFields(fields).setTimestamp()


    // Send action log to configured log channel
    async function sendLog(embed: discord.EmbedBuilder): Promise<void> {
        if (!logChannelId) return
        try {
            const ch = await opendiscord.client.client.channels.fetch(logChannelId)
            if (ch && ch.isTextBased()) await (ch as discord.TextChannel).send({ embeds: [embed] })
        } catch (e: any) {
            opendiscord.log(`LiteBans: failed to send log – ${e.message}`, "error")
        }
    }

    // Register slash commands
    const S = discord.ApplicationCommandOptionType
    const cmds = opendiscord.client.slashCommands

    cmds.add(new api.ODSlashCommand("litebans:gameban",    { type: discord.ApplicationCommandType.ChatInput, name: "gameban",    description: "Ban a Minecraft player via LiteBans.",                          contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String,  required:true },{ name:"reason", description:"Reason",            type:S.String,  required:true },{ name:"duration",description:"Duration (7d,2h,perm)", type:S.String,  required:true },{ name:"silent", description:"Silent?",           type:S.Boolean, required:false }] }))
    cmds.add(new api.ODSlashCommand("litebans:gameunban",  { type: discord.ApplicationCommandType.ChatInput, name: "gameunban",  description: "Unban a Minecraft player via LiteBans.",                        contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String,  required:true },{ name:"reason", description:"Reason",            type:S.String,  required:false }] }))
    cmds.add(new api.ODSlashCommand("litebans:gamemute",   { type: discord.ApplicationCommandType.ChatInput, name: "gamemute",   description: "Mute a Minecraft player via LiteBans.",                         contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String,  required:true },{ name:"reason", description:"Reason",            type:S.String,  required:true },{ name:"duration",description:"Duration (7d,2h,perm)", type:S.String,  required:true },{ name:"silent", description:"Silent?",           type:S.Boolean, required:false }] }))
    cmds.add(new api.ODSlashCommand("litebans:gameunmute", { type: discord.ApplicationCommandType.ChatInput, name: "gameunmute", description: "Unmute a Minecraft player via LiteBans.",                       contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String,  required:true },{ name:"reason", description:"Reason",            type:S.String,  required:false }] }))
    cmds.add(new api.ODSlashCommand("litebans:gamewarn",   { type: discord.ApplicationCommandType.ChatInput, name: "gamewarn",   description: "Warn a Minecraft player via LiteBans.",                         contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String,  required:true },{ name:"reason", description:"Reason",            type:S.String,  required:true },{ name:"silent", description:"Silent?",           type:S.Boolean, required:false }] }))
    cmds.add(new api.ODSlashCommand("litebans:gameunwarn", { type: discord.ApplicationCommandType.ChatInput, name: "gameunwarn", description: "Remove the most recent active warning for a Minecraft player.", contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String,  required:true },{ name:"reason", description:"Reason",            type:S.String,  required:false }] }))


    cmds.add(new api.ODSlashCommand("litebans:history",    { type: discord.ApplicationCommandType.ChatInput, name: "history",    description: "Show full punishment history for a Minecraft player.",         contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String, required:true }] }))
    cmds.add(new api.ODSlashCommand("litebans:checkalts",  { type: discord.ApplicationCommandType.ChatInput, name: "checkalts",  description: "Find alt accounts linked to a player via shared IPs.",        contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String, required:true }] }))
    cmds.add(new api.ODSlashCommand("litebans:checkban",   { type: discord.ApplicationCommandType.ChatInput, name: "checkban",   description: "Check if a Minecraft player currently has an active ban.",    contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String, required:true }] }))
    cmds.add(new api.ODSlashCommand("litebans:checkmute",  { type: discord.ApplicationCommandType.ChatInput, name: "checkmute",  description: "Check if a Minecraft player currently has an active mute.",   contexts: [discord.InteractionContextType.Guild], integrationTypes: [discord.ApplicationIntegrationType.GuildInstall], options: [{ name:"player", description:"Minecraft username", type:S.String, required:true }] }))

    opendiscord.log("LiteBans Integration: slash commands registered.", "plugin")

    // Responders
    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:gameban","",/^gameban/))
    opendiscord.responders.commands.get("litebans:gameban")!.workers.add([new api.ODWorker("litebans:gameban",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.ban,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name=instance.options.getString("player",true), reason=instance.options.getString("reason",true), durRaw=instance.options.getString("duration",true), silent=instance.options.getBoolean("silent",false)??false
        let ms:number; try{ms=parseDuration(durRaw)}catch(e:any){await err(instance,`❌ ${e.message}`);return cancel()}
        await instance.defer(false); const ix=getInteraction(instance)
        const uuid=await resolveUUID(pool,prefix,name)
        if(!uuid){await ix.editReply({content:`❌ UUID not found for **${name}**. They must have joined at least once.`});return cancel()}
        const now=Date.now(),until=ms<0?-1:now+ms
        await pool.query(`INSERT INTO \`${prefix}bans\`(uuid,ip,reason,banned_by_uuid,banned_by_name,removed_by_uuid,removed_by_name,removed_by_date,time,until,template,server_scope,server_origin,silent,ipban,ipban_wildcard,active)VALUES(?,NULL,?,'#console',?,NULL,NULL,NULL,?,?,0,'*','Discord',?,0,0,1)`,[uuid,reason,instance.user.username+" (Discord)",now,until,silent?1:0])
        opendiscord.log(`${instance.user.displayName} banned ${name} (${durRaw})`,"info")
        const banEmbed = ok("🔨 Player Banned",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Duration",value:ms<0?"Permanent":formatDuration(ms),inline:true},{name:"Banned by",value:instance.user.toString(),inline:true},{name:"Silent",value:silent?"Yes":"No",inline:true}],0xe74c3c)
        await sendLog(banEmbed)
        await ix.editReply({embeds:[ok("🔨 Player Banned",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Duration",value:ms<0?"Permanent":formatDuration(ms),inline:true},{name:"Banned by",value:instance.user.toString(),inline:true},{name:"Silent",value:silent?"Yes":"No",inline:true}],0xe74c3c)]})
    })])

    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:gameunban","",/^gameunban/))
    opendiscord.responders.commands.get("litebans:gameunban")!.workers.add([new api.ODWorker("litebans:gameunban",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.ban,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name=instance.options.getString("player",true), reason=instance.options.getString("reason",false)??"Unbanned via Discord"
        await instance.defer(false); const ix=getInteraction(instance)
        const uuid=await resolveUUID(pool,prefix,name)
        if(!uuid){await ix.editReply({content:`❌ UUID not found for **${name}**.`});return cancel()}
        const[res]=await pool.query<mysql.ResultSetHeader>(`UPDATE \`${prefix}bans\` SET active=0,removed_by_uuid='#console',removed_by_name=?,removed_by_date=? WHERE(uuid=? OR uuid=?)AND active=1`,[instance.user.username+" (Discord)",new Date().toISOString().slice(0,19).replace('T',' '),uuid,uuid.replace(/-/g,"")])
        if(res.affectedRows===0){await ix.editReply({content:`⚠️ No active ban for **${name}**.`});return cancel()}
        opendiscord.log(`${instance.user.displayName} unbanned ${name}`,"info")
        const unbanEmbed = ok("✅ Player Unbanned",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Unbanned by",value:instance.user.toString(),inline:true},{name:"Bans lifted",value:res.affectedRows.toString(),inline:true}])
        await sendLog(unbanEmbed)
        await ix.editReply({embeds:[ok("✅ Player Unbanned",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Unbanned by",value:instance.user.toString(),inline:true},{name:"Bans lifted",value:res.affectedRows.toString(),inline:true}])]})
    })])

    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:gamemute","",/^gamemute/))
    opendiscord.responders.commands.get("litebans:gamemute")!.workers.add([new api.ODWorker("litebans:gamemute",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.mute,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name=instance.options.getString("player",true), reason=instance.options.getString("reason",true), durRaw=instance.options.getString("duration",true), silent=instance.options.getBoolean("silent",false)??false
        let ms:number; try{ms=parseDuration(durRaw)}catch(e:any){await err(instance,`❌ ${e.message}`);return cancel()}
        await instance.defer(false); const ix=getInteraction(instance)
        const uuid=await resolveUUID(pool,prefix,name)
        if(!uuid){await ix.editReply({content:`❌ UUID not found for **${name}**.`});return cancel()}
        const now=Date.now(),until=ms<0?-1:now+ms
        await pool.query(`INSERT INTO \`${prefix}mutes\`(uuid,ip,reason,banned_by_uuid,banned_by_name,removed_by_uuid,removed_by_name,removed_by_date,time,until,template,server_scope,server_origin,silent,ipban,ipban_wildcard,active)VALUES(?,NULL,?,'#console',?,NULL,NULL,NULL,?,?,0,'*','Discord',?,0,0,1)`,[uuid,reason,instance.user.username+" (Discord)",now,until,silent?1:0])
        opendiscord.log(`${instance.user.displayName} muted ${name} (${durRaw})`,"info")
        const muteEmbed = ok("🔇 Player Muted",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Duration",value:ms<0?"Permanent":formatDuration(ms),inline:true},{name:"Muted by",value:instance.user.toString(),inline:true},{name:"Silent",value:silent?"Yes":"No",inline:true}],0xe67e22)
        await sendLog(muteEmbed)
        await ix.editReply({embeds:[ok("🔇 Player Muted",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Duration",value:ms<0?"Permanent":formatDuration(ms),inline:true},{name:"Muted by",value:instance.user.toString(),inline:true},{name:"Silent",value:silent?"Yes":"No",inline:true}],0xe67e22)]})
    })])

    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:gameunmute","",/^gameunmute/))
    opendiscord.responders.commands.get("litebans:gameunmute")!.workers.add([new api.ODWorker("litebans:gameunmute",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.mute,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name=instance.options.getString("player",true), reason=instance.options.getString("reason",false)??"Unmuted via Discord"
        await instance.defer(false); const ix=getInteraction(instance)
        const uuid=await resolveUUID(pool,prefix,name)
        if(!uuid){await ix.editReply({content:`❌ UUID not found for **${name}**.`});return cancel()}
        const[res]=await pool.query<mysql.ResultSetHeader>(`UPDATE \`${prefix}mutes\` SET active=0,removed_by_uuid='#console',removed_by_name=?,removed_by_date=? WHERE(uuid=? OR uuid=?)AND active=1`,[instance.user.username+" (Discord)",new Date().toISOString().slice(0,19).replace('T',' '),uuid,uuid.replace(/-/g,"")])
        if(res.affectedRows===0){await ix.editReply({content:`⚠️ No active mute for **${name}**.`});return cancel()}
        opendiscord.log(`${instance.user.displayName} unmuted ${name}`,"info")
        const unmuteEmbed = ok("✅ Player Unmuted",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Unmuted by",value:instance.user.toString(),inline:true},{name:"Mutes lifted",value:res.affectedRows.toString(),inline:true}])
        await sendLog(unmuteEmbed)
        await ix.editReply({embeds:[ok("✅ Player Unmuted",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Unmuted by",value:instance.user.toString(),inline:true},{name:"Mutes lifted",value:res.affectedRows.toString(),inline:true}])]})
    })])

    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:gamewarn","",/^gamewarn/))
    opendiscord.responders.commands.get("litebans:gamewarn")!.workers.add([new api.ODWorker("litebans:gamewarn",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.warn,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name=instance.options.getString("player",true), reason=instance.options.getString("reason",true), silent=instance.options.getBoolean("silent",false)??false
        await instance.defer(false); const ix=getInteraction(instance)
        const uuid=await resolveUUID(pool,prefix,name)
        if(!uuid){await ix.editReply({content:`❌ UUID not found for **${name}**.`});return cancel()}
        await pool.query(`INSERT INTO \`${prefix}warnings\`(uuid,ip,reason,banned_by_uuid,banned_by_name,removed_by_uuid,removed_by_name,removed_by_date,time,until,template,server_scope,server_origin,silent,ipban,ipban_wildcard,active)VALUES(?,NULL,?,'#console',?,NULL,NULL,NULL,?,-1,0,'*','Discord',?,0,0,1)`,[uuid,reason,instance.user.username+" (Discord)",Date.now(),silent?1:0])
        opendiscord.log(`${instance.user.displayName} warned ${name}`,"info")
        const warnEmbed = ok("⚠️ Player Warned",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Warned by",value:instance.user.toString(),inline:true},{name:"Silent",value:silent?"Yes":"No",inline:true}],0xf1c40f)
        await sendLog(warnEmbed)
        await ix.editReply({embeds:[ok("⚠️ Player Warned",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Warned by",value:instance.user.toString(),inline:true},{name:"Silent",value:silent?"Yes":"No",inline:true}],0xf1c40f)]})
    })])

    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:gameunwarn","",/^gameunwarn/))
    opendiscord.responders.commands.get("litebans:gameunwarn")!.workers.add([new api.ODWorker("litebans:gameunwarn",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.warn,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name=instance.options.getString("player",true), reason=instance.options.getString("reason",false)??"Unwarned via Discord"
        await instance.defer(false); const ix=getInteraction(instance)
        const uuid=await resolveUUID(pool,prefix,name)
        if(!uuid){await ix.editReply({content:`❌ UUID not found for **${name}**.`});return cancel()}
        const[rows]=await pool.query<mysql.RowDataPacket[]>(`SELECT id FROM \`${prefix}warnings\` WHERE(uuid=? OR uuid=?)AND active=1 ORDER BY time DESC LIMIT 1`,[uuid,uuid.replace(/-/g,"")])
        if(!rows.length){await ix.editReply({content:`⚠️ No active warning for **${name}**.`});return cancel()}
        await pool.query(`UPDATE \`${prefix}warnings\` SET active=0,removed_by_uuid='#console',removed_by_name=?,removed_by_date=? WHERE id=?`,[instance.user.username+" (Discord)",new Date().toISOString().slice(0,19).replace('T',' '),rows[0].id])
        opendiscord.log(`${instance.user.displayName} removed warning for ${name}`,"info")
        const unwarnEmbed = ok("✅ Warning Removed",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Unwarned by",value:instance.user.toString(),inline:true}])
        await sendLog(unwarnEmbed)
        await ix.editReply({embeds:[ok("✅ Warning Removed",[{name:"Player",value:name,inline:true},{name:"UUID",value:uuid,inline:false},{name:"Reason",value:reason,inline:false},{name:"Unwarned by",value:instance.user.toString(),inline:true}])]})
    })])


    // /history
    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:history","",/^history/))
    opendiscord.responders.commands.get("litebans:history")!.workers.add([new api.ODWorker("litebans:history",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.lookup,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name = instance.options.getString("player",true)
        await instance.defer(false)
        const ix = getInteraction(instance)
        const uuid = await resolveUUID(pool,prefix,name)
        const embed = await buildHistoryEmbed(pool,prefix,name,uuid,color,maxRows)
        await ix.editReply({ content: `📋 Punishment history for \`${name}\`:`, embeds: [embed] })
    })])

    // /checkalts — finds all UUIDs that ever shared an IP with this player
    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:checkalts","",/^checkalts/))
    opendiscord.responders.commands.get("litebans:checkalts")!.workers.add([new api.ODWorker("litebans:checkalts",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.lookup,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name = instance.options.getString("player",true)
        await instance.defer(false)
        const ix = getInteraction(instance)

        const uuid = await resolveUUID(pool,prefix,name)
        if (!uuid) { await ix.editReply({ content: `❌ UUID not found for **${name}**. They must have joined at least once.` }); return cancel() }

        // Get all IPs this player has used
        const [ipRows] = await pool.query<mysql.RowDataPacket[]>(
            `SELECT DISTINCT ip FROM \`${prefix}history\` WHERE (uuid=? OR uuid=?) AND ip IS NOT NULL AND ip != ''`,
            [uuid, uuid.replace(/-/g,"")]
        )
        if (!ipRows.length) {
            const embed = new discord.EmbedBuilder().setTitle(`🔍 Alt Check – ${name}`).setColor(0x3498db).setDescription("No IP history found for this player.").setTimestamp()
            await ix.editReply({ embeds: [embed] }); return
        }

        const ips = ipRows.map((r: any) => r.ip as string)

        // Find all OTHER accounts that used any of those IPs
        const placeholders = ips.map(() => "?").join(",")
        const [altRows] = await pool.query<mysql.RowDataPacket[]>(
            `SELECT DISTINCT h.name, h.uuid, MAX(h.date) as last_seen
             FROM \`${prefix}history\` h
             WHERE h.ip IN (${placeholders})
             AND h.uuid != ? AND h.uuid != ?
             GROUP BY h.uuid, h.name
             ORDER BY last_seen DESC
             LIMIT 20`,
            [...ips, uuid, uuid.replace(/-/g,"")]
        )

        const embed = new discord.EmbedBuilder()
            .setTitle(`🔍 Alt Check – ${name}`)
            .setColor(altRows.length > 0 ? 0xe74c3c : 0x2ecc71)
            .setTimestamp()
            .setFooter({ text: `UUID: ${uuid} | IPs checked: ${ips.length}` })

        if (!altRows.length) {
            embed.setDescription("✅ No alt accounts found sharing the same IP(s).")
        } else {
            const lines = altRows.map((r: any) => {
                const last = r.last_seen ? new Date(r.last_seen).toLocaleDateString("en-GB") : "Unknown"
                return `👤 **${r.name}** | \`${r.uuid}\` | Last seen: ${last}`
            })
            embed.setDescription(`⚠️ **${altRows.length}** potential alt(s) found:\n\n` + lines.join("\n").slice(0, 3900))
        }

        await ix.editReply({ embeds: [embed] })
    })])

    // /checkban
    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:checkban","",/^checkban/))
    opendiscord.responders.commands.get("litebans:checkban")!.workers.add([new api.ODWorker("litebans:checkban",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.lookup,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name = instance.options.getString("player",true)
        await instance.defer(false)
        const ix = getInteraction(instance)

        const uuid = await resolveUUID(pool,prefix,name)
        if (!uuid) { await ix.editReply({ content: `❌ UUID not found for **${name}**.` }); return cancel() }

        const [rows] = await pool.query<mysql.RowDataPacket[]>(
            `SELECT reason, banned_by_name, time, until, server_origin FROM \`${prefix}bans\`
             WHERE (uuid=? OR uuid=?) AND active=1 ORDER BY time DESC LIMIT 1`,
            [uuid, uuid.replace(/-/g,"")]
        )

        const embed = new discord.EmbedBuilder().setTitle(`🔨 Ban Check – ${name}`).setTimestamp().setFooter({ text: `UUID: ${uuid}` })

        if (!rows.length) {
            embed.setColor(0x2ecc71).setDescription("✅ This player has **no active ban**.")
        } else {
            const r = rows[0]
            const since   = new Date(Number(r.time)).toLocaleString("en-GB")
            const expires = Number(r.until) < 0 ? "Never (Permanent)" : new Date(Number(r.until)).toLocaleString("en-GB")
            embed.setColor(0xe74c3c).addFields(
                { name: "Status",    value: "🔴 **BANNED**",               inline: true  },
                { name: "Player",    value: name,                           inline: true  },
                { name: "UUID",      value: uuid,                           inline: false },
                { name: "Reason",    value: r.reason ?? "No reason",        inline: false },
                { name: "Banned by", value: r.banned_by_name ?? "Unknown",  inline: true  },
                { name: "Since",     value: since,                          inline: true  },
                { name: "Expires",   value: expires,                        inline: true  },
                { name: "Server",    value: r.server_origin ?? "Unknown",   inline: true  }
            )
        }
        await ix.editReply({ embeds: [embed] })
    })])

    // /checkmute
    opendiscord.responders.commands.add(new api.ODCommandResponder("litebans:checkmute","",/^checkmute/))
    opendiscord.responders.commands.get("litebans:checkmute")!.workers.add([new api.ODWorker("litebans:checkmute",0,async(instance,p,s,cancel)=>{
        if (!await hasRole(roles.lookup,instance,cancel)) return
        if (!pool){await err(instance,"❌ MySQL not connected.");return cancel()}
        const name = instance.options.getString("player",true)
        await instance.defer(false)
        const ix = getInteraction(instance)

        const uuid = await resolveUUID(pool,prefix,name)
        if (!uuid) { await ix.editReply({ content: `❌ UUID not found for **${name}**.` }); return cancel() }

        const [rows] = await pool.query<mysql.RowDataPacket[]>(
            `SELECT reason, banned_by_name, time, until, server_origin FROM \`${prefix}mutes\`
             WHERE (uuid=? OR uuid=?) AND active=1 ORDER BY time DESC LIMIT 1`,
            [uuid, uuid.replace(/-/g,"")]
        )

        const embed = new discord.EmbedBuilder().setTitle(`🔇 Mute Check – ${name}`).setTimestamp().setFooter({ text: `UUID: ${uuid}` })

        if (!rows.length) {
            embed.setColor(0x2ecc71).setDescription("✅ This player has **no active mute**.")
        } else {
            const r = rows[0]
            const since   = new Date(Number(r.time)).toLocaleString("en-GB")
            const expires = Number(r.until) < 0 ? "Never (Permanent)" : new Date(Number(r.until)).toLocaleString("en-GB")
            embed.setColor(0xe67e22).addFields(
                { name: "Status",   value: "🔴 **MUTED**",                inline: true  },
                { name: "Player",   value: name,                          inline: true  },
                { name: "UUID",     value: uuid,                          inline: false },
                { name: "Reason",   value: r.reason ?? "No reason",       inline: false },
                { name: "Muted by", value: r.banned_by_name ?? "Unknown", inline: true  },
                { name: "Since",    value: since,                         inline: true  },
                { name: "Expires",  value: expires,                       inline: true  },
                { name: "Server",   value: r.server_origin ?? "Unknown",  inline: true  }
            )
        }
        await ix.editReply({ embeds: [embed] })
    })])

    opendiscord.log("LiteBans Integration: all responders ready.", "plugin")

    // Ticket history
    if (!triggers.length) { opendiscord.log("LiteBans Integration: no ticketHistoryTriggers — auto-history disabled.", "plugin"); return }

    opendiscord.events.get("afterTicketCreated")!.listen(async (ticket, creator, channel) => {
        try {
            if (!triggers.includes(ticket.option.id.value)) return
            if (!pool) { await channel.send({ content: "⚠️ LiteBans: MySQL not connected." }); return }
            const answers: {value:string|null}[] = ticket.get("opendiscord:answers")?.value ?? []
            if (!answers.length) { await channel.send({ content: "⚠️ LiteBans: No answers in ticket." }); return }
            const playerName = answers[0].value?.trim()
            if (!playerName) { await channel.send({ content: "⚠️ LiteBans: First answer was empty." }); return }
            const uuid  = await resolveUUID(pool, prefix, playerName)
            const embed = await buildHistoryEmbed(pool, prefix, playerName, uuid, color, maxRows)
            await channel.send({ content: `📋 **Punishment history** for \`${playerName}\`:`, embeds: [embed] })
            opendiscord.log(`LiteBans: posted history for "${playerName}" in ticket ${ticket.id.value}`, "plugin")
        } catch (e: any) { opendiscord.log(`LiteBans: ticket history error – ${e.message}`, "error") }
    })

    opendiscord.log("LiteBans Integration: ticket history active for: " + triggers.join(", "), "plugin")
})

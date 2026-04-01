require('dotenv').config();
const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json());
app.use(cors({ origin: "http://localhost:8081" }));

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SERVER_ID = process.env.DISCORD_SERVER_ID;

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
// Login the bot
client.login(BOT_TOKEN);

// --- Helper function to check if username is in server ---
async function checkIfAlreadyInServer(username) {
    if (!client.isReady()) {
        console.log("Bot not ready yet. Please wait.");
        return "else";
    }

    const guild = client.guilds.cache.get(process.env.SERVER_ID);
    if (!guild) {
        console.log("Guild not found. Check SERVER_ID and bot permissions.");
        return "else";
    }

    try {
        // Ensure we have all members cached
        if (guild.members.cache.size !== guild.memberCount) {
            console.log("Cache incomplete → fetching all members...");
            await guild.members.fetch(); // fills the cache
        } else {
            console.log("Cache already contains all members.");
        }

        // Find matching username
        const member = guild.members.cache.find(
            m => m.user.username.toLowerCase() === username.toLowerCase()
        );

        if (member) {
            console.log("✅ Found member:", member.user.username);
            return "already a member";
        } else {
            console.log("❌ Member not found");
            return "all good"
        }

    } catch (err) {
        console.error("Error checking members:", err);
        return "else";
    }
}

// --- API endpoint ---
app.post("/validate_discord_user", async (req, res) => {
    const { username } = req.body || {};

    if (!username) {
        console.log("missing username error")
        return res.status(400).json({ error: "missing_username" });
    }

    try {
        const alreadyInServer = await checkIfAlreadyInServer(username);
        if (alreadyInServer === "already a member") {
            console.log("already member error")
            return res.status(400).json({ error: "already_member" });
        }
        else if (alreadyInServer === "else") {
            console.log("other error")
            return res.status(400).json({ error: "error" });
        }
        else {
            console.log("SUCCESS")
            res.json({valid: true});
        }
    } catch (err) {
        console.error("Server error:", err);
        res.status(500).json({ error: "server_error" });
    }
});

// --- Dummy Discord invite ---
app.get("/discord_invite", async (req, res) => {
    const invite = `https://discord.gg/ONE_TIME_${Date.now()}`;
    console.log("Generated pseudo invite:", invite);
    res.json({ discordInvite: invite });
});


module.exports = {
    checkIfAlreadyInServer,
    app,
    client,
};

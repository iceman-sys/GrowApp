require('dotenv').config();
const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());

app.use(cors({
    origin: "http://localhost:8081"
}));

const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SERVER_ID = process.env.DISCORD_SERVER_ID;
const SUPPORT_EMAIL = "WeAreOneWithNature@proton.me";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const isLikelyStripeAccountId = (value) => /^acct_[a-zA-Z0-9]+$/.test(String(value || "").trim());

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

async function createDiscordInvite() {
    const guild = client.guilds.cache.get(SERVER_ID);
    if (!guild) throw new Error("Guild not found");
    const channel = guild.channels.cache.find(c => c.type === 0); // type 0 = text channel
    const invite = await channel.createInvite({ maxUses: 1, unique: true, reason: "New community member joined" });
    return invite.url;
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


// #MODIFIED: test DB connection
(async () => {
    try {
        const { data, error } = await supabase
            .from("GROW_community")
            .select("*")
            .limit(1);

        if (error) throw error;

        console.log(data);
        app.listen(3001, () => console.log("Server running on port 3001"));

    } catch (err) {
        console.error("❌ Failed to connect to Supabase:", err);
        process.exit(1);
    }
})();

app.post("/connectPayment", async (req, res) => {
    const { stripeAccountId, discordUsername } = req.body;

    if (!stripeAccountId || !discordUsername) {
        return res.status(400).json({ error: "Missing account ID or username" });
    }
    if (!isLikelyStripeAccountId(stripeAccountId)) {
        return res.status(400).json({
            error: "Invalid Stripe account ID. Please use a valid connected account (starts with acct_).",
        });
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const logDbAddFailure = (error, extra = {}) => {
        const payload = {
            event: "db_add_after_payment_failed",
            notify_email: SUPPORT_EMAIL,
            message: `Failed to add paid user to database. Please send this log to ${SUPPORT_EMAIL}.`,
            stripeAccountId,
            discordUsername,
            timestamp: new Date().toISOString(),
            error: error?.message || String(error),
            extra,
        };
        console.error(JSON.stringify(payload, null, 2));
    };

    const addCommunityMemberWithRetry = async () => {
        const maxAttempts = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const { error: insertError } = await supabase
                .from("community_members")
                .insert({
                    discord_username: discordUsername,
                    stripe_account_id: stripeAccountId,
                    joined_at: new Date().toISOString(),
                });

            if (!insertError) {
                return { success: true, attempts: attempt };
            }

            lastError = insertError;
            logDbAddFailure(insertError, { attempt, maxAttempts });

            if (attempt < maxAttempts) {
                await sleep(300 * attempt);
            }
        }

        return { success: false, attempts: maxAttempts, error: lastError };
    };

    try {
        // Verify destination account exists and is connected to this platform
        try {
            await stripe.accounts.retrieve(stripeAccountId);
        } catch (accountErr) {
            console.error(
                JSON.stringify(
                    {
                        event: "invalid_stripe_destination_account",
                        notify_email: SUPPORT_EMAIL,
                        message: `Stripe destination account validation failed. Please send this log to ${SUPPORT_EMAIL}.`,
                        stripeAccountId,
                        discordUsername,
                        timestamp: new Date().toISOString(),
                        error: accountErr?.message || String(accountErr),
                        code: accountErr?.code,
                    },
                    null,
                    2,
                ),
            );
            return res.status(400).json({
                error:
                    "The Stripe account ID is not valid for this platform. Please use a connected account ID that starts with acct_.",
            });
        }

        // 1️⃣ Create a $3 Payment Intent directly on connected account
        const paymentIntent = await stripe.paymentIntents.create({
            amount: 300, // $3 in cents
            currency: "usd",
            payment_method_types: ["card"],
            // Use `on_behalf_of` for connected accounts (if using Stripe Connect)
            transfer_data: {
                destination: stripeAccountId,
            },
        });

        // 2️⃣ Confirm automatically (you may need frontend to confirm in some flows)
        // For testing purposes, assume auto-confirmed
        if (paymentIntent.status !== "requires_payment_method" && paymentIntent.status !== "requires_confirmation") {
            // 3️⃣ Add user to Supabase DB with retries
            const dbInsert = await addCommunityMemberWithRetry();

            // 4️⃣ Success response (payment can succeed even if DB insertion fails)
            if (!dbInsert.success) {
                return res.json({
                    success: true,
                    databaseAdded: false,
                    warning:
                        "You were not successfully added to the database, but you can still proceed and receive your Discord invite link.",
                    supportEmail: SUPPORT_EMAIL,
                });
            }

            return res.json({ success: true, databaseAdded: true });
        } else {
            return res.status(400).json({ error: "Payment could not be completed" });
        }
    } catch (err) {
        console.error(
            JSON.stringify(
                {
                    event: "connect_payment_failed",
                    notify_email: SUPPORT_EMAIL,
                    message: `Payment processing failed. Please send this log to ${SUPPORT_EMAIL}.`,
                    stripeAccountId,
                    discordUsername,
                    timestamp: new Date().toISOString(),
                    error: err?.message || String(err),
                    code: err?.code,
                    statusCode: err?.statusCode,
                },
                null,
                2,
            ),
        );
        return res.status(500).json({
            error: err.message || "Could not process payment or add you to the community",
        });
    }
});


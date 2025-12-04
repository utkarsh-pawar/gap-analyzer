// @ts-check
require('dotenv').config(); // Load environment variables from .env
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const app = express();
const port = 3000;
let db;

// --- Database Initialization ---
(async () => {
    try {
        db = await open({
            filename: './database.db',
            driver: sqlite3.Database
        });
        await db.exec(`
            CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subreddit TEXT NOT NULL,
                idea TEXT NOT NULL,
                pain_point INTEGER NOT NULL,
                audience_scale INTEGER NOT NULL,
                monetization_potential INTEGER NOT NULL,
                feasibility INTEGER NOT NULL,
                overall_score REAL NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Database connected and table created.');
    } catch (err) {
        console.error('Error connecting to database:', err);
    }
})();

app.use(express.static('public')); // Serve static files

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

app.get('/search', async (req, res) => {
  try {
    // 1. Generate Reddit thread links
    const prompt = "Find 3 diverse and popular subreddits where people discuss problems, frustrations, or unmet needs. Provide only the name of each subreddit, one per line (e.g., 'personalfinance').";

    let geminiResponse;
    try {
      geminiResponse = await model.generateContent(prompt);
    } catch (geminiError) {
      console.error("Gemini API Error:", geminiError);
      return res
        .status(500)
        .json({ error: "Gemini API Error", details: geminiError.message });
    }

    const redditTopics = geminiResponse.response.text();
    const topics = redditTopics.split('\n').filter(topic => topic.trim() !== '');

    let results = [];

    // 2. Fetch and analyze each thread
    for (const topic of topics) {
      // Sanitize the topic name to remove any leading "r/"
      const sanitizedTopic = topic.trim().replace(/^r\//i, '');
      const redditUrl = `https://www.reddit.com/r/${sanitizedTopic}`;
      try {
        console.log(`Fetching content from: ${redditUrl}`);
        const response = await axios.get(redditUrl);
        console.log(`Response status for ${redditUrl}: ${response.status}`);
        const html = response.data;
        console.log(`HTML fetched successfully from ${redditUrl}`);

        try {
          const $ = cheerio.load(html);
          console.log(`Cheerio loaded HTML for ${redditUrl}`);
          const threadContent = $('body').text(); // Extract all text
          console.log(`Extracted thread content from ${redditUrl}`);

          // 3. Analyze thread content with NEW "Practical Analyst" PROMPT
          const analysisPrompt = `
            Analyze the following content from the subreddit '${sanitizedTopic}'. 
            Act as a practical business analyst. Based on the content, provide:
            1. A single, concrete business idea.
            2. A score from 0-100 for "Pain Point Severity".
            3. A score from 0-100 for "Audience Scale".
            4. A score from 0-100 for "Monetization Potential".
            5. A score from 0-100 for "Execution Feasibility" (where 100 is very feasible).
            
            Return ONLY a single, raw JSON object in the format: 
            {"businessIdea": "Your idea here", "painPoint": score, "audienceScale": score, "monetizationPotential": score, "feasibility": score}.
            Do not include any other text or formatting.
            
            Content:
            ${threadContent}
          `;

          let analysisResponse;
          try {
            analysisResponse = await model.generateContent(analysisPrompt);
            const analysisResultText = analysisResponse.response.text();
            
            const cleanedJsonText = analysisResultText.replace(/```json/g, '').replace(/```/g, '').trim();
            const analysisResultJson = JSON.parse(cleanedJsonText);

            const { businessIdea, painPoint, audienceScale, monetizationPotential, feasibility } = analysisResultJson;
            const overallScore = ((painPoint + audienceScale + monetizationPotential + feasibility) / 4).toFixed(1);

            // --- Save valid result to database ---
            if (businessIdea) {
              await db.run(
                'INSERT INTO results (subreddit, idea, pain_point, audience_scale, monetization_potential, feasibility, overall_score) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [redditUrl, businessIdea, painPoint, audienceScale, monetizationPotential, feasibility, overallScore]
              );
              console.log(`Saved result for ${sanitizedTopic} to the database.`);
            }

            results.push({ 
              link: redditUrl, 
              idea: businessIdea,
              pain: painPoint,
              audience: audienceScale,
              monetization: monetizationPotential,
              feasibility: feasibility,
              overall: overallScore
            });

          } catch (analysisError) {
            console.error("Gemini Analysis or JSON Parsing Error:", analysisError);
            results.push({
              link: redditUrl, 
              idea: 'Could not generate or parse analysis.',
              overall: 0
            });
            continue;
          }

        } catch (cheerioError) {
          console.error(`Cheerio Error for ${redditUrl}:`, cheerioError);
          results.push({
            link: redditUrl, 
            idea: 'Error parsing the subreddit page.',
            overall: 0
          });
        }

      } catch (error) {
        console.error(`Error processing link ${redditUrl}:`, error);
        results.push({ 
          link: redditUrl, 
          idea: `Error fetching the subreddit page: ${error.message}`,
          overall: 0
        });
      }
    }

    // 4. Send the results back to the client
    res.json(results);
  } catch (error) {
    console.error("Error during search:", error);
    res.status(500).json({ error: "An error occurred during the search." });
  }
});

// --- New /history endpoint ---
app.get('/history', async (req, res) => {
    try {
        const history = await db.all('SELECT * FROM results ORDER BY createdAt DESC');
        res.json(history);
    } catch (err) {
        console.error('Error fetching history:', err);
        res.status(500).json({ error: 'Failed to retrieve search history.' });
    }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
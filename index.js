const express = require("express");
const cors = require("cors");
const https = require('https');
const fs = require('fs');
const db = require("./config/db.js"); // Import your database connection from db.js
const app = express();


// parse requests of content-type - application/json

app.use(express.json({ limit: '50mb' }));
// parse requests of content-type - application/x-www-form-urlencoded

app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Add Access Control Allow Origin headers
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});
app.use(cors({
    origin: '*'
}));

// Define routes

//Fetch questions and answers
app.get("/api/questions", async (req, res) => {
    const searchTerm = req.query.s;
    if (!searchTerm) {
        return res.json([]);
    }

    // Adjusted query to reflect new schema
    const query = `
    SELECT q.Q_TEXT as question, a.ANSWER_TEXT as answer, a.CONTEXT_ID as contextId
    FROM questions q
    JOIN qa qa ON q.Q_ID = qa.Q_ID
    JOIN answers a ON a.ANSWER_ID = qa.ANSWER_ID
    WHERE q.Q_TEXT LIKE ?
    LIMIT 100;
    
    `;

    const likeSearchTerm = `%${searchTerm}%`;

    try {
        const [results] = await db.promise().query(query, [likeSearchTerm])
        res.status(200).json(results);
    } catch (error) {
        console.error("Error fetching Questions:", error);
        res.status(500).json({ message: "Error fetching Questions" });
    }
});


//pull context table against the answers

app.get("/api/context/:contextId", async (req, res) => {
  const { contextId } = req.params;

  // Updated query to also fetch paragraph texts
  const query = `
      SELECT c.DOC_ID, c.PARAG_ID, dp.PARAG_TEXT
      FROM context c
      LEFT JOIN doc_parag dp ON c.PARAG_ID = dp.PARAG_ID
      WHERE c.CONTEXT_ID = ?
      ORDER BY c.DOC_ID, c.PARAG_ID;
  `;

  try {
      const [results] = await db.promise().query(query, [contextId]);
      res.status(200).json(results);
  } catch (error) {
      console.error("Error fetching Context:", error);
      res.status(500).json({ message: "Error fetching Context" });
  }
});

//Get documents
// Route to get all documents
app.get('/getDocuments', (req, res) => {
  const query = 'SELECT DOC_ID, TITLE FROM documents';

  db.query(query, (error, results) => {
    if (error) {
      console.error(error);
      res.status(500).send('Server error');
      return;
    }
    res.json(results); // Send documents back to the client
  });
});

// Route to handle AJAX request for paragraphs
app.get('/getParagraphs', (req, res) => {
  const docId = req.query.docId;
  const query = 'SELECT * FROM doc_parag WHERE DOC_ID = ?';

  db.query(query, [docId], (error, results) => {
    if (error) {
      console.error(error);
      res.status(500).send('Server error');
      return;
    }
    res.json(results); // Send query results back to the client
  });
});


// set port, listen for requests
const PORT = 2000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}.`);
    
});


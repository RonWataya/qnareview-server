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
    SELECT q.Q_ID as questionId, q.Q_TEXT as question, a.ANSWER_ID as answerId, a.ANSWER_TEXT as answer, a.CONTEXT_ID as contextId
    FROM questions q
    JOIN qa ON q.Q_ID = qa.Q_ID
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

//Save new answer to an existing question
app.post('/save-answer', (req, res) => {
  const { answerText, questionId, contextId } = req.body;

  // First, determine the next available number for ANSWER_ID
  const idQuery = "SELECT ANSWER_ID FROM answers WHERE ANSWER_ID REGEXP '^A_[0-9]+_1$' ORDER BY LENGTH(ANSWER_ID) DESC, ANSWER_ID DESC LIMIT 1";

  db.query(idQuery, async (error, results) => {
      if (error) {
          console.error('Failed to query existing ANSWER_IDs:', error);
          res.json({ success: false, message: 'Failed to generate a unique ANSWER_ID.' });
          return;
      }

      let nextNumber;
      if (results.length > 0) {
          const lastId = results[0].ANSWER_ID;
          const lastNumber = parseInt(lastId.split('_')[1]);
          nextNumber = lastNumber + 1;
      } else {
          nextNumber = 1; // Start from 1 if no existing IDs
      }

      const newAnswerId = `A_${nextNumber}_1`;

      // Insert the new answer with the generated ANSWER_ID
      const insertQuery = 'INSERT INTO answers (ANSWER_ID, ANSWER_TEXT, CONTEXT_ID) VALUES (?, ?, ?)';

      db.query(insertQuery, [newAnswerId, answerText, contextId], (insertError, insertResults) => {
          if (insertError) {
              console.error('Failed to insert new answer:', insertError);
              res.json({ success: false, message: 'Failed to save the new answer with a unique ID.' });
              return;
          }
          
          // After successfully inserting the answer, insert/update the qa table
          const qaInsertQuery = 'INSERT INTO qa (Q_ID, ANSWER_ID) VALUES (?, ?)';

          db.query(qaInsertQuery, [questionId, newAnswerId], (qaError, qaResults) => {
              if (qaError) {
                  console.error('Failed to update qa table:', qaError);
                  res.json({ success: false, message: 'Failed to update the qa table.' });
                  return;
              }
              res.json({ success: true, message: 'New answer saved successfully, and qa table updated.', answerId: newAnswerId });
          });
      });
  });
});

//create a new question and answer
app.post('/create-question-answer', async (req, res) => {
  const { questionText, answerText, docId, paragId } = req.body;
  console.log('Received data:', { questionText, answerText, docId, paragId }); // Debugging line

  try {
    // Step 1: Insert the new question
    const questionQuery = 'INSERT INTO questions (Q_TEXT) VALUES (?)';
    const [questionResult] = await db.promise().query(questionQuery, [questionText]);
    const questionId = questionResult.insertId;
    console.log('Question inserted with ID:', questionId); // Debugging line

    // Step 2: Determine the next CONTEXT_ID
    const contextQuery = "SELECT CONTEXT_ID FROM context WHERE CONTEXT_ID REGEXP '^C_A_[0-9]+_1$' ORDER BY LENGTH(CONTEXT_ID) DESC, CONTEXT_ID DESC LIMIT 1";
    const [contextResults] = await db.promise().query(contextQuery);
    let nextNumber = 1;
    if (contextResults.length > 0) {
      const lastId = contextResults[0].CONTEXT_ID;
      const lastNumber = parseInt(lastId.split('_')[2]);
      nextNumber = lastNumber + 1;
    }
    const contextId = `C_A_${nextNumber}_1`;
    console.log('Generated CONTEXT_ID:', contextId); // Debugging line

    // Step 3: Insert the new context
    const insertContextQuery = 'INSERT INTO context (CONTEXT_ID, DOC_ID, PARAG_ID) VALUES (?, ?, ?)';
    await db.promise().query(insertContextQuery, [contextId, docId, paragId]);
    console.log('Context inserted:', {contextId, docId, paragId}); // Debugging line

    // Step 4: Insert the new answer with the CONTEXT_ID
    const newAnswerId = `A_${nextNumber}_1`; // Correctly using nextNumber
    const insertAnswerQuery = 'INSERT INTO answers (ANSWER_ID, ANSWER_TEXT, CONTEXT_ID) VALUES (?, ?, ?)';
    await db.promise().query(insertAnswerQuery, [newAnswerId, answerText, contextId]);
    console.log('Answer inserted with ID:', newAnswerId); // Debugging line

    // Step 5: Link the question and answer in the qa table
    const insertQAQuery = 'INSERT INTO qa (Q_ID, ANSWER_ID) VALUES (?, ?)';
    await db.promise().query(insertQAQuery, [questionId, newAnswerId]);
    console.log('Linked question and answer:', { questionId, newAnswerId }); // Debugging line

    res.json({ success: true, message: 'New question and answer saved successfully.', questionId, answerId: newAnswerId });
  } catch (error) {
    console.error('Operation failed:', error);
    res.json({ success: false, message: 'An error occurred. Please check the server logs for more details.' });
  }
});


// set port, listen for requests
const PORT = 2000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}.`);
    
});


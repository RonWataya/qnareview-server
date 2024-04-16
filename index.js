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

// Your OpenAI API key and configuration



// Define routes

// auto generated questions

// Route to generate questions
app.post('/api/generate-questions', (req, res) => {
    const { contexts, numberOfQuestions, questionTypes } = req.body;
    let questions = [];

    function generateRandomQuestion(context, questionTypes) {
        // Select a random type if multiple types are selected
        const prefix = questionTypes[Math.floor(Math.random() * questionTypes.length)];
        return `${prefix} ${context}?`;
    }

    // Generate the requested number of questions
    for (let i = 0; i < numberOfQuestions; i++) {
        const context = contexts[i % contexts.length]; // Cycle through contexts if fewer than requested number
        questions.push(generateRandomQuestion(context, questionTypes));
    }

    res.json({ questions });
});


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
app.get('/api/getDocuments', (req, res) => {
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
app.get('/api/getParagraphs', (req, res) => {
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
//update answer
app.post("/api/updateAnswer", async (req, res) => {
  const { answerId, newAnswer } = req.body;

  if (!answerId || !newAnswer) {
      return res.status(400).json({ message: "Missing answerId or newAnswer in request" });
  }

  const query = `
  UPDATE answers SET ANSWER_TEXT = ? WHERE ANSWER_ID = ?;
  `;

  try {
      await db.promise().query(query, [newAnswer, answerId]);
      res.status(200).json({ message: "Answer updated successfully" });
  } catch (error) {
      console.error("Error updating answer:", error);
      res.status(500).json({ message: "Error updating answer" });
  }
});

//Save new answer to an existing question
app.post('/save-answer', async (req, res) => {
  const { newAnswer, contextData, answerId } = req.body;
  console.log('Received data:', { newAnswer, contextData, answerId });

  const connection = await db.promise().getConnection();

  try {
      await connection.beginTransaction();

      // Step 1: Generate and Insert New CONTEXT_ID into `context` table
      const contextQuery = "SELECT CONTEXT_ID FROM context WHERE CONTEXT_ID REGEXP '^C_A_[0-9]+_1$' ORDER BY LENGTH(CONTEXT_ID) DESC, CONTEXT_ID DESC LIMIT 1";
      const [contextResults] = await connection.query(contextQuery);
      let nextContextNumber = 1;
      if (contextResults.length > 0) {
          const lastId = contextResults[0].CONTEXT_ID;
          const lastNumber = parseInt(lastId.match(/\d+/)[0]); // Extract the numeric part
          nextContextNumber = lastNumber + 1;
      }
      const newContextId = `C_A_${nextContextNumber}_1`;

      for (const { docId, paragId } of contextData) {
          const insertContextSql = 'INSERT INTO context (CONTEXT_ID, DOC_ID, PARAG_ID) VALUES (?, ?, ?)';
          await connection.query(insertContextSql, [newContextId, docId, paragId]);
      }

      // Step 2: Update ANSWER_TEXT and CONTEXT_ID in the `answers` table
      const updateAnswerSql = "UPDATE answers SET ANSWER_TEXT = ?, CONTEXT_ID = ? WHERE ANSWER_ID = ?";
      await connection.query(updateAnswerSql, [newAnswer, newContextId, answerId]);

      await connection.commit();
      connection.release();
      res.status(200).json({ message: "Answer and context updated successfully" });
  } catch (error) {
      await connection.rollback();
      connection.release();
      console.error("Error in transaction:", error);
      res.status(500).json({ message: "Failed to update answer and context" });
  }
});




//create a new question and answer
app.post('api/create-question-answer', async (req, res) => {
  const { questionText, answerText, contextData } = req.body;
  // Corrected log statement to include the whole contextData
  console.log('Received data:', { questionText, answerText, contextData });

  try {
      // Step 1: Insert the new question
      const questionQuery = 'INSERT INTO questions (Q_TEXT) VALUES (?)';
      const [questionResult] = await db.promise().query(questionQuery, [questionText]);
      const questionId = questionResult.insertId;
      console.log('Question inserted with ID:', questionId);

      // Step 2: Determine the next CONTEXT_ID
      const contextQuery = "SELECT CONTEXT_ID FROM context WHERE CONTEXT_ID REGEXP '^C_A_[0-9]+_1$' ORDER BY LENGTH(CONTEXT_ID) DESC, CONTEXT_ID DESC LIMIT 1";
      const [contextResults] = await db.promise().query(contextQuery);
      let nextContextNumber = 1;
      if (contextResults.length > 0) {
          const lastId = contextResults[0].CONTEXT_ID;
          const lastNumber = parseInt(lastId.split('_')[2]);
          nextContextNumber = lastNumber + 1;
      }
      const contextId = `C_A_${nextContextNumber}_1`;
      console.log('Generated CONTEXT_ID:', contextId);

      // Step 3: Insert the new context
      for (const { docId, paragId } of contextData) {
          await db.promise().query('INSERT INTO context (CONTEXT_ID, DOC_ID, PARAG_ID) VALUES (?, ?, ?)', [contextId, docId, paragId]);
          console.log('Context inserted:', { contextId, docId, paragId });
      }

      // Step 4: Ensure unique ANSWER_ID
      const answerIdCheckQuery = "SELECT ANSWER_ID FROM answers WHERE ANSWER_ID REGEXP '^A_[0-9]+_1$' ORDER BY LENGTH(ANSWER_ID) DESC, ANSWER_ID DESC LIMIT 1";
      const [answerResults] = await db.promise().query(answerIdCheckQuery);
      let nextAnswerNumber = 1;
      if (answerResults.length > 0) {
          const lastAnswerId = answerResults[0].ANSWER_ID;
          const lastAnswerNumber = parseInt(lastAnswerId.split('_')[1]);
          nextAnswerNumber = Math.max(lastAnswerNumber + 1, nextContextNumber); // Ensure it's not lower than nextContextNumber
      }
      const newAnswerId = `A_${nextAnswerNumber}_1`;

      // Insert the new answer with the CONTEXT_ID
      const insertAnswerQuery = 'INSERT INTO answers (ANSWER_ID, ANSWER_TEXT, CONTEXT_ID) VALUES (?, ?, ?)';
      await db.promise().query(insertAnswerQuery, [newAnswerId, answerText, contextId]);
      console.log('Answer inserted with ID:', newAnswerId);

      // Step 5: Link the question and answer in the qa table
      const insertQAQuery = 'INSERT INTO qa (Q_ID, ANSWER_ID) VALUES (?, ?)';
      await db.promise().query(insertQAQuery, [questionId, newAnswerId]);
      console.log('Linked question and answer:', { questionId, newAnswerId });

      res.json({ success: true, message: 'New question and answer saved successfully.', questionId, answerId: newAnswerId });
  } catch (error) {
      console.error('Operation failed:', error);
      res.json({ success: false, message: 'An error occurred. Please check the server logs for more details.' });
  }
});

//create a new question and answer from draft
app.post('api/create-question-answer-draft', async (req, res) => {
    const { questionText, answerText, contextData } = req.body;
    // Corrected log statement to include the whole contextData
    console.log('Received data:', { questionText, answerText, contextData });
  
    try {
        // Step 1: Insert the new question
        const questionQuery = 'INSERT INTO questions (Q_TEXT) VALUES (?)';
        const [questionResult] = await db.promise().query(questionQuery, [questionText]);
        const questionId = questionResult.insertId;
        console.log('Question inserted with ID:', questionId);
  
        // Step 2: Determine the next CONTEXT_ID
        const contextQuery = "SELECT CONTEXT_ID FROM context WHERE CONTEXT_ID REGEXP '^C_A_[0-9]+_1$' ORDER BY LENGTH(CONTEXT_ID) DESC, CONTEXT_ID DESC LIMIT 1";
        const [contextResults] = await db.promise().query(contextQuery);
        let nextContextNumber = 1;
        if (contextResults.length > 0) {
            const lastId = contextResults[0].CONTEXT_ID;
            const lastNumber = parseInt(lastId.split('_')[2]);
            nextContextNumber = lastNumber + 1;
        }
        const contextId = `C_A_${nextContextNumber}_1`;
        console.log('Generated CONTEXT_ID:', contextId);
  
        // Step 3: Insert the new context
        for (const { docId, paragId } of contextData) {
            await db.promise().query('INSERT INTO context (CONTEXT_ID, DOC_ID, PARAG_ID) VALUES (?, ?, ?)', [contextId, docId, paragId]);
            console.log('Context inserted:', { contextId, docId, paragId });
        }
  
        // Step 4: Ensure unique ANSWER_ID
        const answerIdCheckQuery = "SELECT ANSWER_ID FROM answers WHERE ANSWER_ID REGEXP '^A_[0-9]+_1$' ORDER BY LENGTH(ANSWER_ID) DESC, ANSWER_ID DESC LIMIT 1";
        const [answerResults] = await db.promise().query(answerIdCheckQuery);
        let nextAnswerNumber = 1;
        if (answerResults.length > 0) {
            const lastAnswerId = answerResults[0].ANSWER_ID;
            const lastAnswerNumber = parseInt(lastAnswerId.split('_')[1]);
            nextAnswerNumber = Math.max(lastAnswerNumber + 1, nextContextNumber); // Ensure it's not lower than nextContextNumber
        }
        const newAnswerId = `A_${nextAnswerNumber}_1`;
  
        // Insert the new answer with the CONTEXT_ID
        const insertAnswerQuery = 'INSERT INTO answers (ANSWER_ID, ANSWER_TEXT, CONTEXT_ID) VALUES (?, ?, ?)';
        await db.promise().query(insertAnswerQuery, [newAnswerId, answerText, contextId]);
        console.log('Answer inserted with ID:', newAnswerId);
  
        // Step 5: Link the question and answer in the qa table
        const insertQAQuery = 'INSERT INTO qa (Q_ID, ANSWER_ID) VALUES (?, ?)';
        await db.promise().query(insertQAQuery, [questionId, newAnswerId]);
        console.log('Linked question and answer:', { questionId, newAnswerId });
  
        res.json({ success: true, message: 'New question and answer saved successfully.', questionId, answerId: newAnswerId });
    } catch (error) {
        console.error('Operation failed:', error);
        res.json({ success: false, message: 'An error occurred. Please check the server logs for more details.' });
    }
  });
// Login route
app.post('/api/login', (req, res) => {
  const { token } = req.body;
  const query = 'SELECT * FROM tokens WHERE token = ? LIMIT 1';

  db.query(query, [token], (err, results) => {
      if (err) {
          res.json({ success: false, message: "Error querying the database." });
          return;
      }
      if (results.length > 0) {
          // Token is valid
          res.json({ success: true, message: "Login successful." });
      } else {
          // Token is invalid
          res.json({ success: false, message: "Invalid token." });
      }
  });
});

// set port, listen for requests
const PORT = 2000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}.`);
    
});


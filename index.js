const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection URL
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = "./uploads";
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const fileTypes = /pdf/;
    const extname = fileTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = fileTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Only PDFs are allowed"));
    }
  },
}).single("pdf");

async function run() {
  try {
    // Connect to MongoDB
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("resmedx");
    const collection = db.collection("notices");
    const userCollection = db.collection("users");

    // User Registration
    app.post("/api/v1/register", async (req, res) => {
      const { name, email, password } = req.body;

      // Check if email already exists
      const existingUser = await userCollection.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: "User already exists",
        });
      }

      // Hash the password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Insert user into the database
      await userCollection.insertOne({ name, email, password: hashedPassword });

      res.status(201).json({
        success: true,
        message: "User registered successfully",
      });
    });

    // User Login
    app.post("/api/v1/login", async (req, res) => {
      const { email, password } = req.body;

      try {
        // Find user by email
        const user = await userCollection.findOne({ email });
        if (!user) {
          return res.status(401).json({ message: "Invalid email or password" });
        }

        // Compare hashed password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
          return res.status(401).json({ message: "Invalid email or password" });
        }

        // Generate JWT token without expiration
        const token = jwt.sign({ email: user.email }, process.env.JWT_SECRET);

        res.cookie("token", jwt.sign({ email }, process.env.JWT_SECRET), {
          httpOnly: true,
          maxAge: 24 * 60 * 60 * 1000, // 1 day
        });

        res.json({
          success: true,
          message: "Login successful",
          token,
        });
      } catch (error) {
        console.error("Error during login:", error);
        res.status(500).json({ message: "An error occurred during login" });
      }
    });

    // ==============================================================
    // PDF Upload Route
    // ==============================================================
    app.post("/api/v1/notices", (req, res) => {
      upload(req, res, async (err) => {
        if (err) {
          return res.status(400).json({ error: err.message });
        }

        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        // Extract the title from the request body
        const { title } = req.body;

        // Check if the title is provided
        if (!title) {
          return res.status(400).json({ error: "Title is required" });
        }

        try {
          const { originalname, filename, path } = req.file;
          const fileData = {
            title, // Add the title here
            originalName: originalname,
            fileName: filename,
            filePath: path,
            uploadedAt: new Date(),
          };

          // Insert file metadata into MongoDB
          const result = await collection.insertOne(fileData);
          res.status(201).json({
            message: "File uploaded successfully",
            data: result,
          });
        } catch (dbErr) {
          res.status(500).json({
            error: "Failed to save file data in database",
          });
        }
      });
    });

    // Get all PDF metadata
    app.get("/api/v1/notices", async (req, res) => {
      try {
        const collection = client.db("resmedx").collection("notices");
        const notices = await collection.find({}).toArray();

        res.status(200).json(notices);
      } catch (error) {
        console.error("Error fetching notices:", error);
        res.status(500).json({ error: "Failed to fetch notices" });
      }
    });

    // Serve a specific PDF file
    app.get("/api/v1/notices/:filename", (req, res) => {
      const filename = req.params.filename;
      const filepath = path.join(__dirname, "uploads", filename);

      res.sendFile(filepath, (err) => {
        if (err) {
          console.error("Error sending file:", err);
          res.status(404).json({ error: "File not found" });
        }
      });
    });

    // Delete a specific PDF file and its metadata
    app.delete("/api/v1/notices/:id", async (req, res) => {
      const { id } = req.params;
      try {
        const notice = await collection.findOne({ _id: new ObjectId(id) });
        if (!notice) {
          return res.status(404).json({ error: "File not found" });
        }

        // Delete the file from the filesystem
        const filePath = path.join(__dirname, "uploads", notice.fileName);
        fs.unlink(filePath, (err) => {
          if (err) {
            console.error("Error deleting file:", err);
            return res.status(500).json({ error: "Failed to delete file" });
          }
        });

        // Delete the document from the database
        await collection.deleteOne({ _id: new ObjectId(id) });
        res.status(200).json({ message: "File deleted successfully" });
      } catch (error) {
        console.error("Error deleting file:", error);
        res.status(500).json({ error: "Failed to delete file" });
      }
    });

    // Edit a specific PDF's metadata
    // app.patch("/api/v1/notices/:id", async (req, res) => {
    //   const { id } = req.params;
    //   const { originalName } = req.body; // Expecting to update the originalName

    //   if (!originalName) {
    //     return res.status(400).json({ error: "Original name is required" });
    //   }

    //   try {
    //     const result = await collection.updateOne(
    //       { _id: new ObjectId(id) },
    //       { $set: { originalName } }
    //     );

    //     if (result.matchedCount === 0) {
    //       return res.status(404).json({ error: "File not found" });
    //     }

    //     res.status(200).json({ message: "File metadata updated successfully" });
    //   } catch (error) {
    //     console.error("Error updating file metadata:", error);
    //     res.status(500).json({ error: "Failed to update file metadata" });
    //   }
    // });

    //   NOTICES END

    // Start the server
    app.listen(port, () => {
      console.log(`Server is running on http://localhost:${port}`);
    });
  } finally {
  }
}

run().catch(console.dir);

// Test route
app.get("/", (req, res) => {
  const serverStatus = {
    message: "Server is running smoothly",
    timestamp: new Date(),
  };
  res.json(serverStatus);
});

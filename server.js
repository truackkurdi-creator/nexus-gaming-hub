const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Backend Storage ---
// DATA_DIR: لەسەر Railway بە /data دادەنرێت (Volume)، لەناوخۆ __dirname بەکاردێت
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const usersPath = path.join(DATA_DIR, 'users.json');
const itemsPath = path.join(DATA_DIR, 'items.json');
const settingsPath = path.join(DATA_DIR, 'settings.json');
const statsPath = path.join(DATA_DIR, 'stats.json');
const chatPath = path.join(DATA_DIR, 'chat.json');
const readJSON = async (f, def) => {
  try {
    if (fs.existsSync(f)) {
      const data = fs.readFileSync(f, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`Error reading ${f}:`, err);
  }
  return def;
};

const writeJSON = async (f, d) => {
  try {
    fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf8");
  } catch (err) {
    console.error(`Error writing to ${f}:`, err);
  }
};

// --- Middleware Setup ---
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname)));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")),
});
const upload = multer({ storage });

// --- API Routes ---

app.get("/api/stats", async (req, res) => {
  const items = await readJSON(itemsPath, []);
  const itemsCount = (items||[]).length;
  const usersCount = await readJSON(usersPath, []).length;
  const totalDownloads = items.reduce((sum, item) => sum + (item.downloads || 0), 0);
  res.json({ itemsCount, usersCount, downloads: totalDownloads });
});

app.post("/api/download/:id", async (req, res) => {
  const itemId = req.params.id;
  let items = await readJSON(itemsPath, []);
  const itemIndex = items.findIndex(i => i.id == itemId);
  if (itemIndex > -1) {
    items[itemIndex].downloads = (items[itemIndex].downloads || 0) + 1;
    await writeJSON(itemsPath, items);
  }
  res.json({ success: true });
});

app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  let users = await readJSON(usersPath, []);
  
  if (users.find(u => u.email === email))
    return res.status(400).json({ error: "ئەم ئیمەیڵە پێشتر تۆمارکراوە" });

  const role = users.length === 0 ? "Ownership" : "member";
  const token = Math.random().toString(36).substring(2) + Date.now().toString(36);

  const newUser = {
    id: Date.now(),
    name,
    email,
    password,
    role,
    avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`,
    token,
  };

  users.push(newUser);
  await writeJSON(usersPath, users);
  res.json({ success: true, user: newUser });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const users = await readJSON(usersPath, []);
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: "ئیمەیڵ یان پاسۆرد هەڵەیە" });
  res.json({ success: true, user });
});

app.get("/api/items", async (req, res) => {
  const items = await readJSON(itemsPath, []);
  res.json({
    apps: items.filter((i) => i.type === "app"),
    tools: items.filter((i) => i.type === "tool"),
    mods: items.filter((i) => i.type === "mod"),
  });
});

app.post(
  "/api/add-item",
  upload.fields([{ name: "itemFile", maxCount: 1 }, { name: "imageFiles", maxCount: 5 }, { name: "tutorialFile", maxCount: 1 }]),
  async (req, res) => {
    const { token, type, title, category, rating, downloadUrl, imageUrl, tutorial, tutorialUrl, tutorialSourceType } = req.body;
    const users = await readJSON(usersPath, []);
    const requester = users.find(u => u.token === token);
    
    // ڕۆڵەکانی کە بۆیان هەیە شت زیاد بکەن
    const allowedRoles = ["Ownership", "owner", "admin"];
    if (!requester || !allowedRoles.includes(requester.role)) {
      return res.status(403).json({ error: "مافت نییە (پێویستیت بە ڕۆڵی بەرزتر هەیە)" });
    }

    const items = await readJSON(itemsPath, []);
    
    const finalDownloadUrl = req.files && req.files['itemFile'] ? `/uploads/${req.files['itemFile'][0].filename}` : (downloadUrl || "#");
    
    let finalImageUrls = [];
    let fileIndex = 0;
    for (let i = 1; i <= 5; i++) {
       const sourceType = req.body['imgSourceType_' + i];
       if (sourceType === 'file') {
          if (req.files && req.files['imageFiles'] && req.files['imageFiles'][fileIndex]) {
             finalImageUrls.push(`/uploads/${req.files['imageFiles'][fileIndex].filename}`);
             fileIndex++;
          }
       } else if (sourceType === 'url') {
          finalImageUrls.push(req.body['imageUrl_' + i]);
       }
    }
    
    if (finalImageUrls.length === 0) {
      finalImageUrls = ["https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600"];
    }

    let finalTutorial = tutorial || "";
    if (tutorialSourceType === 'file' && req.files && req.files['tutorialFile']) {
      finalTutorial = `/uploads/${req.files['tutorialFile'][0].filename}`;
    } else if (tutorialSourceType === 'url') {
      finalTutorial = tutorialUrl || "";
    }

    const newItem = {
      id: Date.now(),
      title,
      category,
      type,
      downloadUrl: finalDownloadUrl,
      imageUrl: finalImageUrls[0],
      imageUrls: finalImageUrls,
      tutorial: finalTutorial,
      rating: rating || "5.0",
      downloads: 0
    };

    items.push(newItem);
    await writeJSON(itemsPath, items);
    res.json({ success: true, item: newItem });
  }
);

app.post("/api/delete-item", async (req, res) => {
  const { token, id } = req.body;
  const users = await readJSON(usersPath, []);
  const requester = users.find(u => u.token === token);
  if (!requester || !["Ownership", "owner", "admin", "staff"].includes(requester.role)) {
    return res.status(403).json({ error: "مافت نییە بۆ سڕینەوە" });
  }
  let items = await readJSON(itemsPath, []);
  items = items.filter(i => i.id !== parseInt(id));
  await writeJSON(itemsPath, items);
  res.json({ success: true });
});

app.post(
  "/api/edit-item-full",
  upload.fields([{ name: "itemFile", maxCount: 1 }, { name: "imageFiles", maxCount: 5 }, { name: "tutorialFile", maxCount: 1 }]),
  async (req, res) => {
    const { token, id, type, title, category, downloadUrl, imageUrl, tutorial, tutorialUrl, tutorialSourceType } = req.body;
    const users = await readJSON(usersPath, []);
    const requester = users.find(u => u.token === token);
    
    // Check if requester exists and has permission (including 'staff' which can add items)
    if (!requester || !["Ownership", "owner", "admin", "staff"].includes(requester.role)) {
      return res.status(403).json({ error: "مافت نییە بۆ دەستکاریکردن" });
    }

    let items = await readJSON(itemsPath, []);
    let itemIndex = items.findIndex(i => i.id === parseInt(id));
    if (itemIndex === -1) return res.status(404).json({ error: "بابەتەکە نەدۆزرایەوە" });

    const finalDownloadUrl = req.files && req.files['itemFile'] ? `/uploads/${req.files['itemFile'][0].filename}` : (downloadUrl || items[itemIndex].downloadUrl);
    
    let finalImageUrls = [];
    let fileIndex = 0;
    for (let i = 1; i <= 5; i++) {
       const sourceType = req.body['imgSourceType_' + i];
       if (sourceType === 'file') {
          if (req.files && req.files['imageFiles'] && req.files['imageFiles'][fileIndex]) {
             finalImageUrls.push(`/uploads/${req.files['imageFiles'][fileIndex].filename}`);
             fileIndex++;
          }
       } else if (sourceType === 'url') {
          const url = req.body['imageUrl_' + i];
          if (url) finalImageUrls.push(url);
       }
    }
    if (finalImageUrls.length === 0) {
       finalImageUrls = items[itemIndex].imageUrls || (items[itemIndex].imageUrl ? [items[itemIndex].imageUrl] : ["https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600"]);
    }

    let finalTutorial = tutorial !== undefined ? tutorial : items[itemIndex].tutorial;
    if (tutorialSourceType === 'file' && req.files && req.files['tutorialFile']) {
      finalTutorial = `/uploads/${req.files['tutorialFile'][0].filename}`;
    } else if (tutorialSourceType === 'url') {
      finalTutorial = tutorialUrl !== undefined ? tutorialUrl : finalTutorial;
    }

    items[itemIndex] = {
      ...items[itemIndex],
      title: title || items[itemIndex].title,
      category: category || items[itemIndex].category,
      type: type || items[itemIndex].type,
      downloadUrl: finalDownloadUrl,
      imageUrl: finalImageUrls[0] || items[itemIndex].imageUrl,
      imageUrls: finalImageUrls,
      tutorial: finalTutorial
    };

    await writeJSON(itemsPath, items);
    res.json({ success: true, item: items[itemIndex] });
  }
);

app.post("/api/update-profile", upload.single("avatarFile"), async (req, res) => {
  const { token, name, email, password, avatar } = req.body;
  const users = await readJSON(usersPath, []);
  let userIndex = users.findIndex(u => u.token === token);
  if (userIndex === -1) return res.status(401).json({ error: "هەژمار نەدۆزرایەوە" });
  
  if (name) users[userIndex].name = name;
  if (email) users[userIndex].email = email;
  if (password) users[userIndex].password = password;
  if (req.file) users[userIndex].avatar = `/uploads/${req.file.filename}`;
  else if (avatar) users[userIndex].avatar = avatar;
  
  await writeJSON(usersPath, users);
  res.json({ success: true, user: users[userIndex] });
});
app.get("/api/users", async (req, res) => {
  const { token } = req.query;
  const users = await readJSON(usersPath, []);
  const requester = users.find(u => u.token === token);
  if (!requester || (requester.role !== "Ownership" && requester.role !== "owner")) {
    return res.status(403).json({ error: "مافت نییە (پێویست بە خاوەندارێتی دەکات)" });
  }
  const safeUsers = users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
  res.json(safeUsers);
});

app.post("/api/assign-role", async (req, res) => {
  const { token, targetEmail, newRole } = req.body;
  const users = await readJSON(usersPath, []);
  const requester = users.find(u => u.token === token);
  
  if (!requester || (requester.role !== "Ownership" && requester.role !== "owner")) {
    return res.status(403).json({ error: "تەنها خاوەنی ماڵپەڕ دەتوانێت ڕۆڵ بگۆڕێت" });
  }

  let targetIndex = users.findIndex(u => u.email === targetEmail);
  if (targetIndex === -1) return res.status(404).json({ error: "کەسەکە نەدۆزرایەوە" });
  
  users[targetIndex].role = newRole;
  await writeJSON(usersPath, users);
  res.json({ success: true, message: `ڕۆڵی ${targetEmail} گۆڕدرا بۆ ${newRole}` });
});

app.post("/api/ai-chat", async (req, res) => {
  const { message } = req.body;
  const s = await readJSON(settingsPath, { geminiApiKey: process.env.GEMINI_API_KEY || "" });

  if (!s.geminiApiKey)
    return res.json({
      reply: "بۆ کارکردنی ئەی ئای پێویستە API Key دابنرێت لەکاتی کارپێکردن بە .env وە.",
    });

  try {
    const genAI = new GoogleGenerativeAI(s.geminiApiKey);
    const items = await readJSON(itemsPath, []);
    const availableItems = items.map((i) => `- ${i.title} (${i.category})`).join("\n");

    const systemPrompt = `تۆ NEXUS AI یت. زمانی کوردی بەکاربهێنە. داتابەیسەکەمان: \n${availableItems}`;
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    model.generateContent(systemPrompt + "\n\nبەکارهێنەر: " + message).then(result => {
       res.json({ reply: result.response.text().replace(/\n/g, "<br>") });
    }).catch(e => {
       console.error("Gemini AI API Error:", e.message);
       res.json({ reply: "کێشەیەک لە گووگڵ جێمینای هەیە (ڕەنگە کێشە لە API Key بێت):<br><br>" + e.message });
    });
  } catch (error) {
    res.json({ reply: "هەڵەیەک لە کارپێکردنی ئەی ئای ڕوویدا: " + error.message });
  }
});

let onlineUsers = 0;
io.on("connection", async (socket) => {
  onlineUsers++;
  io.emit("userCount", onlineUsers);

  const chatHistory = await readJSON(chatPath, []);
  socket.emit("chatHistory", chatHistory);

  socket.on("chatMessage", async (msg) => {
    let history = await readJSON(chatPath, []);
    history.push(msg);
    if (history.length > 100) history = history.slice(history.length - 100);
    await writeJSON(chatPath, history);
    socket.broadcast.emit("chatMessage", msg);
  });
  
  socket.on("deleteMessage", async (data) => {
    const users = await readJSON(usersPath, []);
    const requester = users.find(u => u.token === data.token);
    if (requester && ["admin", "owner", "Ownership"].includes(requester.role)) {
       let history = await readJSON(chatPath, []);
       history = history.filter(m => m.id !== data.msgId);
       await writeJSON(chatPath, history);
       io.emit("messageDeleted", data.msgId);
    }
  });

  socket.on("disconnect", () => {
    onlineUsers--;
    io.emit("userCount", onlineUsers);
  });
});

const PORT = 3000; // Fixed to match Railway public networking (routes to port 3000)

// Health check route
app.get("/health", (req, res) => res.json({ status: "ok" }));

server.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on http://0.0.0.0:${PORT}`));

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const webpush = require('web-push');
const mongoose = require('mongoose');
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middlewares ---
app.use(cors({
  origin: '*', // 在生产环境建议限制为你的 Netlify 域名
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// --- Configuration ---
const APP_PASSWORD = process.env.APP_PASSWORD || '123456';
// MongoDB Connection String (Get this from MongoDB Atlas)
const MONGODB_URI = process.env.MONGODB_URI; 

// --- MongoDB Schemas ---
const taskSchema = new mongoose.Schema({
  id: String,
  title: String,
  date: String,
  startTime: String,
  duration: Number,
  category: String,
  completed: Boolean,
  goalId: String,
  reminderOffset: Number,
  notified: { type: Boolean, default: false },
  history: Array
});

const habitSchema = new mongoose.Schema({
  id: String,
  name: String,
  logs: { type: Map, of: Boolean }
});

const goalSchema = new mongoose.Schema({
  id: String,
  title: String,
  status: String,
  deadline: String
});

const inventorySchema = new mongoose.Schema({
  id: String,
  name: String,
  category: String,
  quantity: Number,
  status: String,
  purchaseDate: String,
  expiryDate: String
});

const subscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, unique: true },
  keys: {
    p256dh: String,
    auth: String
  }
});

const Task = mongoose.model('Task', taskSchema);
const Habit = mongoose.model('Habit', habitSchema);
const Goal = mongoose.model('Goal', goalSchema);
const Inventory = mongoose.model('Inventory', inventorySchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// --- Database Connection ---
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));
} else {
  console.warn('⚠️ MONGODB_URI not found. Data will NOT persist in cloud environment!');
}

// --- AI Configuration (Gemini) ---
// API_KEY must be set in environment variables
let aiClient = null;
if (process.env.API_KEY) {
  aiClient = new GoogleGenAI({ apiKey: process.env.API_KEY });
}

// --- Web Push Configuration ---
// If keys are not in env, generate them (Ephemeral for cloud, best to set in env vars)
let PUBLIC_VAPID_KEY = process.env.PUBLIC_VAPID_KEY;
let PRIVATE_VAPID_KEY = process.env.PRIVATE_VAPID_KEY;

if (!PUBLIC_VAPID_KEY || !PRIVATE_VAPID_KEY) {
  const vapidKeys = webpush.generateVAPIDKeys();
  PUBLIC_VAPID_KEY = vapidKeys.publicKey;
  PRIVATE_VAPID_KEY = vapidKeys.privateKey;
  console.log('--- GENERATED VAPID KEYS (Save these to your Env Vars!) ---');
  console.log('PUBLIC_VAPID_KEY:', PUBLIC_VAPID_KEY);
  console.log('PRIVATE_VAPID_KEY:', PRIVATE_VAPID_KEY);
  console.log('-----------------------------------------------------------');
}

webpush.setVapidDetails(
  'mailto:user@example.com',
  PUBLIC_VAPID_KEY,
  PRIVATE_VAPID_KEY
);

// --- Helpers ---
const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 9);

// Auth Middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token || token !== APP_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// --- Push Notification Routes ---
app.get('/api/vapid-key', (req, res) => {
  res.json({ publicKey: PUBLIC_VAPID_KEY });
});

app.post('/api/subscribe', async (req, res) => {
  const subData = req.body;
  try {
    // Upsert subscription
    await Subscription.findOneAndUpdate(
      { endpoint: subData.endpoint },
      subData,
      { upsert: true, new: true }
    );
    console.log('Client subscribed/updated.');
    res.status(201).json({});
  } catch (e) {
    console.error('Subscribe Error:', e);
    res.status(500).json({});
  }
});

// --- Push Notification Cron (Check every minute) ---
setInterval(async () => {
  if (mongoose.connection.readyState !== 1) return; // DB not connected

  try {
    const subs = await Subscription.find({});
    if (subs.length === 0) return;

    const now = new Date();
    const currentTimestamp = Math.floor(now.getTime() / 60000) * 60000;

    // Find tasks that need notification
    // Logic: Not completed, not notified, offset != -1, trigger time matches current minute
    const tasks = await Task.find({ completed: false, notified: false, reminderOffset: { $ne: -1 } });
    
    const tasksToNotify = tasks.filter(t => {
      const taskTimeStr = `${t.date}T${t.startTime}:00`;
      const taskDate = new Date(taskTimeStr);
      if (isNaN(taskDate.getTime())) return false;
      
      const offset = t.reminderOffset !== undefined ? t.reminderOffset : 5;
      const triggerDate = new Date(taskDate.getTime() - (offset * 60000));
      const triggerTimestamp = Math.floor(triggerDate.getTime() / 60000) * 60000;
      
      return currentTimestamp === triggerTimestamp;
    });

    if (tasksToNotify.length > 0) {
      console.log(`Found ${tasksToNotify.length} tasks to notify.`);
      
      for (const task of tasksToNotify) {
        const offset = task.reminderOffset !== undefined ? task.reminderOffset : 5;
        const timeDesc = offset === 0 ? '现在开始' : `将在 ${offset} 分钟后开始`;

        const payload = JSON.stringify({
          title: 'LifeOS 日程提醒',
          body: `任务 "${task.title}" ${timeDesc} (${task.startTime})`,
          icon: '/icon.png'
        });

        const promises = subs.map(sub => 
          webpush.sendNotification(sub, payload).catch(async err => {
            if (err.statusCode === 410 || err.statusCode === 404) {
               await Subscription.deleteOne({ endpoint: sub.endpoint });
               return null; 
            }
            console.error('Push Error:', err.message);
          })
        );
        await Promise.all(promises);

        // Mark as notified
        task.notified = true;
        await task.save();
      }
    }
  } catch (e) {
    console.error("Notification Loop Error:", e);
  }
}, 60000);

// --- API Routes ---

app.post('/api/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) res.json({ success: true, token: APP_PASSWORD });
  else res.status(401).json({ success: false });
});

app.get('/api/data', authMiddleware, async (req, res) => {
  try {
    const [tasks, habits, goals, inventory] = await Promise.all([
      Task.find({}),
      Habit.find({}),
      Goal.find({}),
      Inventory.find({})
    ]);
    res.json({ tasks, habits, goals, inventory });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Universal Sync (Replaced by specific module syncs for MongoDB efficiency, 
// but keeping full-overwrite logic for compatibility with frontend structure)
app.post('/api/sync/:module', authMiddleware, async (req, res) => {
  const { module } = req.params;
  const data = req.body; // Expects Array

  try {
    if (module === 'tasks') {
      await Task.deleteMany({});
      if(data.length > 0) await Task.insertMany(data);
    } else if (module === 'habits') {
      await Habit.deleteMany({});
      if(data.length > 0) await Habit.insertMany(data);
    } else if (module === 'goals') {
      await Goal.deleteMany({});
      if(data.length > 0) await Goal.insertMany(data);
    } else if (module === 'inventory') {
      await Inventory.deleteMany({});
      if(data.length > 0) await Inventory.insertMany(data);
    } else {
      return res.status(400).json({ error: 'Invalid module' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// --- AI Chat (Gemini) ---
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { message, history } = req.body;
  if (!aiClient) return res.status(500).json({ text: "AI API Key 未配置。" });

  try {
    const now = new Date();
    const systemInstruction = `You are LifeOS assistant (dudu). Current Time: ${now.toLocaleString()}.
    If user wants to create a task, output JSON ONLY: {"tool": "createTask", "args": {"title": "...", "date": "YYYY-MM-DD", "startTime": "HH:mm", "duration": 60, "category": "工作", "reminderOffset": 5}}
    If user wants to add inventory, output JSON ONLY: {"tool": "addToInventory", "args": {"name": "...", "quantity": 1, "category": "..."}}
    Otherwise reply in helpful Chinese. Do not use Markdown formatting for the JSON.`;

    // Construct conversation for Gemini
    // Gemini handles history slightly differently, but we can just prompt it
    let contents = systemInstruction + "\n\nChat History:\n";
    if (history && Array.isArray(history)) {
      history.forEach(h => {
        contents += `${h.role === 'model' ? 'Assistant' : 'User'}: ${h.text}\n`;
      });
    }
    contents += `User: ${message}`;

    const response = await aiClient.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: contents,
    });

    const responseText = response.text || "";
    let finalResponse = responseText;
    let dataChanged = false;
    
    const jsonMatch = responseText.match(/\{[\s\S]*"tool"[\s\S]*\}/);

    if (jsonMatch) {
      try {
        const toolCall = JSON.parse(jsonMatch[0]);
        
        if (toolCall.tool === 'createTask') {
          const newTask = {
            id: generateId(),
            title: toolCall.args.title || "新任务",
            date: toolCall.args.date || now.toISOString().split('T')[0],
            startTime: toolCall.args.startTime || "09:00",
            duration: toolCall.args.duration || 60,
            category: toolCall.args.category || "工作",
            reminderOffset: toolCall.args.reminderOffset !== undefined ? toolCall.args.reminderOffset : 5,
            completed: false,
            history: []
          };
          await Task.create(newTask);
          finalResponse = `已创建任务: ${newTask.title}`;
          dataChanged = true;
        } else if (toolCall.tool === 'addToInventory') {
           const newItem = {
             id: generateId(),
             name: toolCall.args.name || "新物品",
             quantity: toolCall.args.quantity || 1,
             category: toolCall.args.category || '通用',
             status: '全新',
             purchaseDate: now.toISOString().split('T')[0]
           };
           await Inventory.create(newItem);
           finalResponse = `已添加物品: ${newItem.name}`;
           dataChanged = true;
        }
      } catch (e) {
        console.error("Tool execution failed", e);
      }
    }
    res.json({ text: finalResponse, dataChanged });
  } catch (e) {
    console.error(e);
    res.status(500).json({ text: "AI 服务异常: " + e.message });
  }
});

// --- AI Review (Gemini) ---
app.post('/api/review', authMiddleware, async (req, res) => {
  if (!aiClient) return res.status(500).json({ text: "AI API Key 未配置。" });
  
  try {
     const [recentTasks, habits] = await Promise.all([
        Task.find({}).sort({id: -1}).limit(10),
        Habit.find({})
     ]);

     const prompt = `分析以下数据生成简短的个人周报:\n任务:${JSON.stringify(recentTasks)}\n习惯:${JSON.stringify(habits)}`;
     
     const response = await aiClient.models.generateContent({
       model: 'gemini-2.5-flash',
       contents: prompt
     });

     res.json({ text: response.text || "生成失败" });
  } catch(e) {
     res.status(500).json({ text: "生成失败" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

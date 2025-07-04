import express from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import ethers from "ethers";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_FILE = path.join(__dirname, "../../users.json");
const router = express.Router();
const JWT_SECRET = "supersecretkey";

// Extend Request type to include user
interface AuthRequest extends Request {
  user?: any;
}

async function loadUsers() {
  try {
    const data = await fs.readFile(USERS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
async function saveUsers(users: any[]) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
}

// Register endpoint
router.post("/register", asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  const users = await loadUsers();
  if (users.find((u: any) => u.username === username)) return res.status(400).json({ error: "Username already exists" });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, passwordHash, wallets: [], notificationPrefs: {} };
  users.push(user);
  await saveUsers(users);
  res.json({ success: true });
}));

// Login endpoint (returns JWT for MVP)
router.post("/login", asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const users = await loadUsers();
  const user = users.find((u: any) => u.username === username);
  if (!user) return res.status(400).json({ error: "Invalid username or password" });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ error: "Invalid username or password" });
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ success: true, token, userId: user.id });
}));

// Helper to wrap async route handlers for Express
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
): (req: Request, res: Response, next: NextFunction) => void {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// JWT auth middleware
function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid token" });
    return;
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// Add wallet endpoint (protected)
router.post("/wallets", requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { wallet, signature, message } = req.body;
  const userId = req.user?.userId;
  if (!userId || !wallet || !signature || !message) return res.status(400).json({ error: "userId, wallet, signature, and message required" });
  // Verify signature
  let recovered;
  try {
    recovered = ethers.utils.verifyMessage(message, signature);
  } catch (err) {
    return res.status(400).json({ error: "Invalid signature" });
  }
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    return res.status(400).json({ error: "Signature does not match wallet address" });
  }
  const users = await loadUsers();
  const user = users.find((u: any) => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.wallets.includes(wallet)) user.wallets.push(wallet);
  await saveUsers(users);
  res.json({ success: true, wallets: user.wallets });
}));

// List wallets endpoint (protected)
router.get("/wallets", requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const users = await loadUsers();
  const user = users.find((u: any) => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ wallets: user.wallets });
}));

// Remove wallet endpoint (protected)
router.delete("/wallets", requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { wallet } = req.body;
  const userId = req.user?.userId;
  if (!userId || !wallet) return res.status(400).json({ error: "userId and wallet required" });
  const users = await loadUsers();
  const user = users.find((u: any) => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  const idx = user.wallets.indexOf(wallet);
  if (idx === -1) return res.status(400).json({ error: "Wallet not found" });
  user.wallets.splice(idx, 1);
  await saveUsers(users);
  res.json({ success: true, wallets: user.wallets });
}));

export default router; 
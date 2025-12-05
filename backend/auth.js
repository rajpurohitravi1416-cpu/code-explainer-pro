// backend/auth.js
import fs from "fs";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USERS_FILE = join(__dirname, "users.json");
const SECRET_KEY = process.env.JWT_SECRET || "fallback_secret_change_in_production";

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, "[]");
    return [];
  }
  try {
    const data = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading users file:", error);
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error("Error saving users file:", error);
  }
}

export function registerUser(email, password) {
  const users = readUsers();
  if (users.find(u => u.email === email)) return { error: "User already exists" };
  
  try {
    const hash = bcrypt.hashSync(password, 10);
    users.push({ email, password: hash });
    saveUsers(users);
    return { message: "User registered successfully" };
  } catch (error) {
    console.error("Registration error:", error);
    return { error: "Registration failed" };
  }
}

export function loginUser(email, password) {
  const users = readUsers();
  const user = users.find(u => u.email === email);
  
  if (!user) return { error: "User not found" };
  
  try {
    if (!bcrypt.compareSync(password, user.password)) {
      return { error: "Invalid password" };
    }
    
    const token = jwt.sign({ email }, SECRET_KEY, { expiresIn: "12h" });
    return { token };
  } catch (error) {
    console.error("Login error:", error);
    return { error: "Login failed" };
  }
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET_KEY);
  } catch (error) {
    console.error("Token verification error:", error);
    return null;
  }
}
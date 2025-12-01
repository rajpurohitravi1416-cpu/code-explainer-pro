import fs from "fs";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import path from "path";

const USERS_FILE = path.join(path.resolve(), "users.json");
const SECRET_KEY = process.env.JWT_SECRET || "please_change_this_secret";

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

export function registerUser(email, password) {
  const users = readUsers();
  if (users.find(u => u.email === email)) return { error: "User already exists" };
  const hash = bcrypt.hashSync(password, 10);
  users.push({ email, password: hash });
  saveUsers(users);
  return { message: "User registered successfully" };
}

export function loginUser(email, password) {
  const users = readUsers();
  const user = users.find(u => u.email === email);
  if (!user) return { error: "User not found" };
  if (!bcrypt.compareSync(password, user.password)) return { error: "Invalid password" };
  const token = jwt.sign({ email }, process.env.JWT_SECRET || "please_change_this_secret", { expiresIn: "12h" });
  return { token };
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || "please_change_this_secret");
  } catch {
    return null;
  }
}

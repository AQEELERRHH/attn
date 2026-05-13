import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'users.json');

if (!existsSync(DB_PATH)) {
  writeFileSync(DB_PATH, JSON.stringify({ users: {} }));
}

function readDB() {
  return JSON.parse(readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export function saveUser(address, userData) {
  const db = readDB();
  db.users[address.toLowerCase()] = {
    ...userData,
    updatedAt: new Date().toISOString(),
  };
  writeDB(db);
}

export function getUser(address) {
  const db = readDB();
  return db.users[address.toLowerCase()] || null;
}

export function getAllUsers() {
  const db = readDB();
  return Object.values(db.users);
}

export function userExists(address) {
  const db = readDB();
  return !!db.users[address.toLowerCase()];
}
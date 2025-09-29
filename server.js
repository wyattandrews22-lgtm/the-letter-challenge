// server.js
// Simple WebSocket server for Letter Challenge (matchmaking + room sync)
// Usage: npm init -y && npm i ws express
// Run: node server.js

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve a simple health endpoint
app.get("/", (req, res) => res.send("Letter Challenge WS server"));

/*
Room structure:
rooms = {
  roomId: {
    players: [ws1, ws2],
    state: { letters: [...], mode, turn, p1Score, p2Score, foundWords: [] }
  }
}
*/
const rooms = new Map();
const waiting = []; // queue of sockets waiting to be matched

function makeId(len=6){ return crypto.randomBytes(len).toString('hex').slice(0,len); }

function send(ws, type, payload){
  const msg = JSON.stringify({ type, payload });
  try { ws.send(msg); } catch(e){ /* ignore */ }
}

// When a client connects
wss.on("connection", (ws) => {
  ws.id = makeId(4);
  ws.roomId = null;

  // helper to clean up when disconnected
  ws.on("close", () => {
    if(ws.roomId && rooms.has(ws.roomId)){
      const room = rooms.get(ws.roomId);
      // notify other player
      room.players.forEach(p => { if(p !== ws && p.readyState === WebSocket.OPEN) send(p, "peer-left", {}); });
      rooms.delete(ws.roomId);
    } else {
      // remove from waiting if present
      const idx = waiting.indexOf(ws);
      if(idx >= 0) waiting.splice(idx,1);
    }
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return; }
    const { type, payload } = msg;

    // create a private room with code
    if(type === "create-room"){
      const roomId = makeId(3);
      const room = {
        id: roomId,
        players: [ws],
        state: null
      };
      rooms.set(roomId, room);
      ws.roomId = roomId;
      send(ws, "room-created", { roomId });
      return;
    }

    // join a specific code room
    if(type === "join-room"){
      const { roomId } = payload;
      if(!rooms.has(roomId)) { send(ws, "error", { message: "Room not found" }); return; }
      const room = rooms.get(roomId);
      if(room.players.length >= 2){ send(ws, "error", { message: "Room full" }); return; }
      room.players.push(ws);
      ws.roomId = roomId;
      // start game state (server chooses letters)
      const state = initGameState(payload.mode || "versus");
      room.state = state;
      // notify both players
      room.players.forEach((p, i) => {
        send(p, "room-joined", { roomId, playerIndex: i+1, state });
      });
      return;
    }

    // quick-match (pair with first waiting)
    if(type === "quick-match"){
      if(waiting.length > 0){
        const peer = waiting.shift();
        const roomId = makeId(3);
        const room = { id: roomId, players: [peer, ws], state: initGameState(payload.mode || "versus") };
        rooms.set(roomId, room);
        peer.roomId = roomId;
        ws.roomId = roomId;
        // send match info
        send(peer, "matched", { roomId, playerIndex: 1, state: room.state });
        send(ws, "matched", { roomId, playerIndex: 2, state: room.state });
      } else {
        waiting.push(ws);
        send(ws, "waiting", {});
      }
      return;
    }

    // start game in an existing room (host triggers)
    if(type === "start-game"){
      const room = rooms.get(ws.roomId);
      if(!room) return;
      // initialize state if not set
      if(!room.state) room.state = initGameState(payload.mode || "versus");
      // send state to both
      room.players.forEach((p,i) => send(p, "game-start", { state: room.state, playerIndex: i+1 }));
      return;
    }

    // sync move: submit-word. payload: { word, playerIndex }
    if(type === "submit-word"){
      const room = rooms.get(ws.roomId);
      if(!room) return;
      // update server authoritative state: prevent duplicates, update scores
      const { word, playerIndex } = payload;
      const state = room.state;
      if(!state || !word) return;
      if(state.foundWordsSet.has(word)) {
        send(ws, "move-rejected", { reason: "already-found" });
        return;
      }
      // verify that word is valid by letters constraint (server uses dictionary loaded from file on startup)
      if(!isWordValid(word, state.letters)) { send(ws, "move-rejected", { reason: "invalid-word" }); return; }
      // accept
      state.foundWords.push({ word, by: playerIndex });
      state.foundWordsSet.add(word);
      const pts = word.length;
      if(playerIndex === 1) state.p1Score += pts; else state.p2Score += pts;
      // toggle turn
      state.turn = (playerIndex === 1) ? 2 : 1;
      // broadcast update
      room.players.forEach(p => send(p, "state-update", { state }));
      return;
    }

    // client requests full state
    if(type === "get-state"){
      const room = rooms.get(ws.roomId);
      if(room) send(ws, "state-update", { state: room.state });
      return;
    }
  });
});

// --- helper functions & minimal dictionary load (server-side) ---
const fs = require("fs");
let serverDictionary = new Set();
try {
  const text = fs.readFileSync("./words.txt", "utf8");
  text.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(Boolean).forEach(w => serverDictionary.add(w));
  console.log("Loaded dictionary words:", serverDictionary.size);
} catch(e){
  console.warn("words.txt not found on server; some validation won't run.");
}

function initGameState(mode="versus"){
  const size = (mode === "basic") ? 5 : (mode === "terrible") ? 10 : 20;
  const letters = pickLettersWithAtLeastNWords(size, 3); // guarantee at least 3 words
  const state = {
    mode,
    letters,           // array of single-letter uppercase
    turn: 1,
    p1Score: 0,
    p2Score: 0,
    foundWords: [],    // [{word, by}]
    foundWordsSet: new Set(),
  };
  // convert set to array before sending; but state kept server-side with set
  state.foundWordsSet = new Set();
  return state;
}

function pickLettersWithAtLeastNWords(size, n){
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split('');
  for(let attempt=0; attempt<10000; attempt++){
    const cand = shuffleArray(alpha).slice(0, size);
    const count = countDictionaryMatches(cand);
    if(count >= n) return cand;
  }
  // fallback: return first size letters
  return alpha.slice(0, size);
}

function countDictionaryMatches(lettersArr){
  let count = 0;
  if(serverDictionary.size === 0) return 5; // if no server dictionary, assume ok
  const letters = lettersArr.map(l => l.toLowerCase());
  for(let word of serverDictionary){
    if(word.length < 2) continue;
    // check if word can be made with letters (frequency allowed)
    if(canMake(word, letters)) count++;
    if(count >= 1000) break; // stop early
  }
  return count;
}

function canMake(word, lettersArr){
  const counts = {};
  lettersArr.forEach(l => counts[l] = (counts[l] || 0) + 1);
  for(const ch of word){
    if(!counts[ch]) return false;
    counts[ch]--;
  }
  return true;
}
function isWordValid(word, lettersArr){
  // server checks dictionary and letter-constraint if dictionary is available
  if(serverDictionary.size && !serverDictionary.has(word.toLowerCase())) return false;
  return canMake(word, lettersArr.map(l=>l.toLowerCase()));
}
function shuffleArray(array){
  for(let i=array.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [array[i],array[j]]=[array[j],array[i]];
  }
  return array;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Server listening on", PORT));

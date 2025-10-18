import { MongoClient } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL;

export class MessagesRepo {
  constructor() {
    this.inMemory = !MONGO_URL;
    if (this.inMemory) {
      // message: { id, type: 'dm'|'group', convId, from, to?, text, at, participantsLower, groupId?, groupName? }
      this.messages = [];
      console.log('MessagesRepo using in-memory storage');
    } else {
      this.client = new MongoClient(MONGO_URL);
      this.ready = this.client.connect().then(() => {
        this.db = this.client.db();
        this.col = this.db.collection('messages');
        this.col.createIndex({ convId: 1, at: -1 }).catch(() => {});
        this.col.createIndex({ participantsLower: 1, at: -1 }).catch(() => {});
        console.log('MessagesRepo connected to MongoDB');
      });
    }
  }

  async save(message) {
    // Ensure participantsLower exists
    if (!message.participantsLower || !Array.isArray(message.participantsLower)) {
      const lowers = [message.from, message.to].filter(Boolean).map(s => (s || '').toLowerCase()).sort();
      message.participantsLower = lowers;
    }
    if (this.inMemory) {
      this.messages.push(message);
      if (this.messages.length > 10000) {
        this.messages.splice(0, this.messages.length - 10000);
      }
      return message;
    }
    await this.ready;
    await this.col.insertOne(message);
    return message;
  }

  async recent(convId, limit = 50) {
    if (this.inMemory) {
      const list = this.messages.filter(m => m.convId === convId);
      return list.slice(Math.max(0, list.length - limit));
    }
    await this.ready;
    const docs = await this.col
      .find({ convId })
      .sort({ at: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse();
  }

  // Returns DM + Group conversations the user participates in
  async recentConversations(forUser, limit = 20) {
    const meLower = (forUser || '').toLowerCase();
    if (this.inMemory) {
      const latestByConv = new Map();
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (!m.participantsLower?.includes(meLower)) continue;
        if (!latestByConv.has(m.convId)) latestByConv.set(m.convId, m);
      }
      const items = Array.from(latestByConv.values())
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, limit)
        .map(last => ({
          convId: last.convId,
          type: last.type || 'dm',
          with: (last.type === 'group') ? (last.groupName || 'Group') : otherOf(last, forUser),
          lastFrom: last.from,
          lastMessageText: last.text,
          lastMessageAt: last.at
        }));
      return items;
    }
    await this.ready;
    const pipeline = [
      { $match: { participantsLower: { $in: [meLower] } } },
      { $sort: { at: -1 } },
      { $group: { _id: '$convId', last: { $first: '$$ROOT' } } },
      { $limit: limit }
    ];
    const docs = await this.col.aggregate(pipeline).toArray();
    return docs
      .map(d => {
        const last = d.last;
        const type = last.type || 'dm';
        const withName = type === 'group' ? (last.groupName || 'Group') : otherOf(last, forUser);
        return {
          convId: d._id,
          type,
          with: withName,
          lastFrom: last.from,
          lastMessageText: last.text,
          lastMessageAt: last.at
        };
      })
      .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
  }
}

function otherOf(msg, me) {
  const meLower = (me || '').toLowerCase();
  const fromLower = (msg.from || '').toLowerCase();
  const toLower = (msg.to || '').toLowerCase();
  if (fromLower !== meLower) return msg.from;
  return msg.to;
}
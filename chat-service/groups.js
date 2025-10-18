import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL;

export class GroupsRepo {
  constructor() {
    this.inMemory = !MONGO_URL;
    if (this.inMemory) {
      this.map = new Map(); // id -> group
      this._idSeq = 1;
      // group: { id, name, members: [UserName], membersLower: [lower], adminsLower: [lower], createdAt }
      console.log('GroupsRepo using in-memory storage');
    } else {
      this.client = new MongoClient(MONGO_URL);
      this.ready = this.client.connect().then(() => {
        this.db = this.client.db();
        this.col = this.db.collection('groups');
        this.col.createIndex({ membersLower: 1 }).catch(() => {});
        this.col.createIndex({ name: 1 }).catch(() => {});
        console.log('GroupsRepo connected to MongoDB');
      });
    }
  }

  async create({ name, creator }) {
    const createdAt = new Date().toISOString();
    const creatorLower = (creator || '').toLowerCase();
    if (this.inMemory) {
      const id = String(this._idSeq++);
      const g = {
        id,
        name,
        members: [creator],
        membersLower: [creatorLower],
        adminsLower: [creatorLower],
        createdAt
      };
      this.map.set(id, g);
      return g;
    }
    await this.ready;
    const doc = { name, members: [creator], membersLower: [creatorLower], adminsLower: [creatorLower], createdAt };
    const res = await this.col.insertOne(doc);
    return { id: String(res.insertedId), ...doc };
  }

  async addMember(groupId, username) {
    const nameLower = (username || '').toLowerCase();
    if (this.inMemory) {
      const g = this.map.get(groupId);
      if (!g) return null;
      if (!g.membersLower.includes(nameLower)) {
        g.membersLower.push(nameLower);
        g.members.push(username);
      }
      return g;
    }
    await this.ready;
    const _id = new ObjectId(groupId);
    await this.col.updateOne(
      { _id },
      { $addToSet: { membersLower: nameLower, members: username } }
    );
    return this.findById(groupId);
  }

  async removeMember(groupId, username) {
    const nameLower = (username || '').toLowerCase();
    if (this.inMemory) {
      const g = this.map.get(groupId);
      if (!g) return null;
      g.membersLower = g.membersLower.filter(x => x !== nameLower);
      g.members = g.members.filter(x => x.toLowerCase() !== nameLower);
      return g;
    }
    await this.ready;
    const _id = new ObjectId(groupId);
    await this.col.updateOne(
      { _id },
      { $pull: { membersLower: nameLower, members: { $in: [username] } } }
    );
    return this.findById(groupId);
  }

  async listForUser(username) {
    const meLower = (username || '').toLowerCase();
    if (this.inMemory) {
      return Array.from(this.map.values()).filter(g => g.membersLower.includes(meLower));
    }
    await this.ready;
    const docs = await this.col.find({ membersLower: { $in: [meLower] } }).toArray();
    return docs.map(d => ({ id: String(d._id), name: d.name, members: d.members, membersLower: d.membersLower, adminsLower: d.adminsLower, createdAt: d.createdAt }));
  }

  async isMember(groupId, username) {
    const meLower = (username || '').toLowerCase();
    const g = await this.findById(groupId);
    if (!g) return false;
    return g.membersLower.includes(meLower);
  }

  async findById(groupId) {
    if (this.inMemory) {
      return this.map.get(groupId) || null;
    }
    await this.ready;
    const _id = new ObjectId(groupId);
    const d = await this.col.findOne({ _id });
    if (!d) return null;
    return { id: String(d._id), name: d.name, members: d.members, membersLower: d.membersLower, adminsLower: d.adminsLower, createdAt: d.createdAt };
  }
}
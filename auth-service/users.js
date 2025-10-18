import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL;

export class UsersRepo {
  constructor() {
    this.inMemory = !MONGO_URL;
    if (this.inMemory) {
      this.map = new Map(); // id -> user
      this.byName = new Map(); // username -> id
      this._idSeq = 1;
      console.log('UsersRepo using in-memory storage');
    } else {
      this.client = new MongoClient(MONGO_URL);
      this.ready = this.client.connect().then(() => {
        this.db = this.client.db(); // default from URL path
        this.col = this.db.collection('users');
        this.col.createIndex({ username: 1 }, { unique: true }).catch(() => {});
        console.log('UsersRepo connected to MongoDB');
      });
    }
  }

  async create({ username, passwordHash }) {
    if (this.inMemory) {
      if (this.byName.has(username)) throw new Error('duplicate username');
      const id = String(this._idSeq++);
      const user = { id, username, passwordHash };
      this.map.set(id, user);
      this.byName.set(username, id);
      return user;
    }
    await this.ready;
    const result = await this.col.insertOne({ username, passwordHash });
    return { id: String(result.insertedId), username, passwordHash };
  }

  async findByUsername(username) {
    if (this.inMemory) {
      const id = this.byName.get(username);
      if (!id) return null;
      return this.map.get(id);
    }
    await this.ready;
    const doc = await this.col.findOne({ username });
    if (!doc) return null;
    return { id: String(doc._id), username: doc.username, passwordHash: doc.passwordHash };
  }
}
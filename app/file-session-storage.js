import fs from 'fs';
import path from 'path';
import { Session } from '@shopify/shopify-api';

export class FileSessionStorage {
    constructor(dir) {
        this.dir = dir;
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    async storeSession(session) {
        const filePath = path.join(this.dir, `${session.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(session.toObject ? session.toObject() : session, null, 2));
        return true;
    }

    async loadSession(id) {
        const filePath = path.join(this.dir, `${id}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return new Session(data);
            } catch (e) {
                console.error(`Error loading session ${id}:`, e);
            }
        }
        return undefined;
    }

    async deleteSession(id) {
        const filePath = path.join(this.dir, `${id}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }

    async deleteSessions(ids) {
        for (const id of ids) {
            await this.deleteSession(id);
        }
        return true;
    }

    async findSessionsByShop(shop) {
        const sessions = [];
        const files = fs.readdirSync(this.dir);
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
                    if (data.shop === shop) {
                        sessions.push(new Session(data));
                    }
                } catch (e) {
                    // ignore bad files
                }
            }
        }
        return sessions;
    }
}

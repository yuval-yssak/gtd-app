import 'dotenv/config'; // globalSetup runs in the parent process, where the per-worker setupFiles (incl. dotenv) never ran
import { MongoClient } from 'mongodb';

// Vitest globalSetup: the default export runs once before the suite; the function it RETURNS runs
// once after the whole run finishes (teardown). We only need teardown here — dropping the per-run
// test databases this invocation created.
//
// Worker processes namespace their test DBs by `process.ppid` (see mainLoader.namespaceTestDB);
// that ppid equals THIS (parent) process's pid, so we can find and drop every `*_p<pid>` database
// the run leaked. Without this, each `npm run test` would leave behind a fresh set of databases.
export default function setup() {
    return async function teardown() {
        const url = process.env.MONGO_DB_URL; // same var as config.mongoDBConfig.DBUrl; read directly since config.ts isn't init'd in the parent process
        if (!url) {
            return;
        }

        const suffix = `_p${process.pid}`;
        const client = new MongoClient(url);
        try {
            await client.connect();
            const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
            const ours = databases.filter((d) => d.name.endsWith(suffix));
            await Promise.all(ours.map((d) => client.db(d.name).dropDatabase()));
        } finally {
            await client.close();
        }
    };
}

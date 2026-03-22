import type {
    AggregateOptions,
    AnyBulkWriteOperation,
    BulkWriteOptions,
    Collection,
    Document,
    Filter,
    FindOptions, // not generic in mongodb v7 — type param was removed
    InsertOneOptions,
    MongoClient,
    OptionalUnlessRequiredId,
    UpdateFilter,
    UpdateOptions,
    WithId,
} from 'mongodb';

class AbstractDAO<S extends Document> {
    databaseName!: string;
    dbClient!: MongoClient;
    _collection!: Collection<S>;
    COLLECTION_NAME!: string;

    async init(client: MongoClient, dbName: string) {
        this.databaseName = dbName;
        this.dbClient = client;

        const existingCollections: Collection[] = await this.dbClient.db(dbName).collections();

        const alreadyExisting: Collection | undefined = existingCollections.find((c) => c.collectionName === this.COLLECTION_NAME);
        if (!alreadyExisting) {
            await this.dbClient.db(dbName).createCollection(this.COLLECTION_NAME);
        }
        this._collection = client.db(dbName).collection<S>(this.COLLECTION_NAME);
    }

    async bulkWrite(operations: AnyBulkWriteOperation<S>[], options?: BulkWriteOptions) {
        if (options) return await this._collection.bulkWrite(operations, options);
        else return await this._collection.bulkWrite(operations);
    }

    async deleteAll() {
        if (!this.databaseName.match(/test/))
            /* c8 ignore next */
            throw new Error('delete all documents should only be used in test mode');
        await this._collection.deleteMany({});
    }

    async drop() {
        if (!this.databaseName.match(/test/))
            /* c8 ignore next */
            throw new Error(`drop ${this.COLLECTION_NAME} should only be used in test mode`);
        await this._collection.drop();
    }

    // this should only be used when the expected result can be contained in memory as one chunk
    async findArray<T = S>(filter: Filter<S> = {}, options: FindOptions = {}) {
        return await this._collection.find<WithId<T>>(filter, options).toArray();
    }

    async *findSequence<T = S>(filter: Filter<S>, options: FindOptions = {}): AsyncGenerator<WithId<T>> {
        const cursor = this._collection.find<WithId<T>>(filter, options);

        while (await cursor.hasNext()) {
            // Safe cast: hasNext() guarantees next() won't return null
            yield await (cursor.next() as Promise<WithId<T>>);
        }
    }

    // this should only be used when the expected result can be contained in memory as one chunk
    async aggregateArray<T extends Document = Document>(pipeline: Document[], options: AggregateOptions = {}) {
        return await this._collection.aggregate<T>(pipeline, options).toArray();
    }

    async *aggregateSequence<T extends Document = Document>(pipeline: Document[], options: AggregateOptions = {}): AsyncGenerator<T> {
        const cursor = this._collection.aggregate<T>(pipeline, options);

        while (await cursor.hasNext()) {
            // Safe cast: hasNext() guarantees next() won't return null
            yield await (cursor.next() as Promise<T>);
        }
    }

    async updateOne(filter: Filter<S>, update: UpdateFilter<S>, updateOptions?: UpdateOptions) {
        return await this._collection.updateOne(filter, update, updateOptions ?? {});
    }

    async updateMany(filter: Filter<S>, update: UpdateFilter<S>, updateOptions?: UpdateOptions) {
        return await this._collection.updateMany(filter, update, updateOptions ?? {});
    }

    async insertOne(doc: OptionalUnlessRequiredId<S>, options?: InsertOneOptions) {
        return await this._collection.insertOne(doc, options ?? {});
    }

    async insertMany(docs: OptionalUnlessRequiredId<S>[], options?: BulkWriteOptions) {
        return await this._collection.insertMany(docs, options ?? {});
    }

    async countDocuments() {
        return await this._collection.countDocuments();
    }

    initializeUnorderedBulkOp() {
        return this._collection.initializeUnorderedBulkOp();
    }

    get collection() {
        return this._collection;
    }
}

export default AbstractDAO;

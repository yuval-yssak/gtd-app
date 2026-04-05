import type { AggregateOptions, AnyBulkWriteOperation, Collection, Document, Filter, MongoClient, OptionalUnlessRequiredId, WithId } from 'mongodb';

class AbstractDAO<S extends Document> {
    databaseName!: string;
    dbClient!: MongoClient;
    _collection!: Collection<S>;
    COLLECTION_NAME!: string;

    async init(client: MongoClient, dbName: string) {
        this.databaseName = dbName;
        this.dbClient = client;
        await this.ensureCollectionExists(dbName);
        this._collection = client.db(dbName).collection<S>(this.COLLECTION_NAME);
    }

    private async ensureCollectionExists(dbName: string): Promise<void> {
        const existing: Collection[] = await this.dbClient.db(dbName).collections();
        const alreadyExists = existing.some((c) => c.collectionName === this.COLLECTION_NAME);
        if (!alreadyExists) {
            await this.dbClient.db(dbName).createCollection(this.COLLECTION_NAME);
        }
    }

    async bulkWrite(operations: AnyBulkWriteOperation<S>[], options?: Parameters<Collection<S>['bulkWrite']>[1]) {
        return await this._collection.bulkWrite(operations, options ?? {});
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

    async findOne(filter: Filter<S>, options?: Parameters<Collection<S>['findOne']>[1]) {
        return await this._collection.findOne(filter, options);
    }

    // this should only be used when the expected result can be contained in memory as one chunk
    async findArray<T = S>(filter: Filter<S> = {}, options: Parameters<Collection<S>['find']>[1] = {}) {
        return await this._collection.find<WithId<T>>(filter, options).toArray();
    }

    async *findSequence<T = S>(filter: Filter<S>, options: Parameters<Collection<S>['find']>[1] = {}): AsyncGenerator<WithId<T>> {
        for await (const doc of this._collection.find<WithId<T>>(filter, options)) {
            yield doc;
        }
    }

    // this should only be used when the expected result can be contained in memory as one chunk
    async aggregateArray<T extends Document = Document>(pipeline: Document[], options: AggregateOptions = {}) {
        return await this._collection.aggregate<T>(pipeline, options).toArray();
    }

    async *aggregateSequence<T extends Document = Document>(pipeline: Document[], options: AggregateOptions = {}): AsyncGenerator<T> {
        for await (const doc of this._collection.aggregate<T>(pipeline, options)) {
            yield doc;
        }
    }

    async updateOne(filter: Filter<S>, update: Parameters<Collection<S>['updateOne']>[1], updateOptions?: Parameters<Collection<S>['updateOne']>[2]) {
        return await this._collection.updateOne(filter, update, updateOptions ?? {});
    }

    async updateMany(filter: Filter<S>, update: Parameters<Collection<S>['updateMany']>[1], updateOptions?: Parameters<Collection<S>['updateMany']>[2]) {
        return await this._collection.updateMany(filter, update, updateOptions ?? {});
    }

    async insertOne(doc: OptionalUnlessRequiredId<S>, options?: Parameters<Collection<S>['insertOne']>[1]) {
        return await this._collection.insertOne(doc, options ?? {});
    }

    async insertMany(docs: OptionalUnlessRequiredId<S>[], options?: Parameters<Collection<S>['insertMany']>[1]) {
        return await this._collection.insertMany(docs, options ?? {});
    }

    async countDocuments(filter: Filter<S> = {}, options?: Parameters<Collection<S>['countDocuments']>[1]) {
        return await this._collection.countDocuments(filter, options ?? {});
    }

    initializeUnorderedBulkOp() {
        return this._collection.initializeUnorderedBulkOp();
    }

    // Cast filter/update objects to `never` to work around MongoDB driver's `InferIdType`
    // widening `_id` to `ObjectId` when the collection schema declares it optional.
    // Centralized here so callers never need their own `as never` casts.

    async deleteByOwner(entityId: string, userId: string): Promise<void> {
        await this._collection.deleteOne({ _id: entityId, user: userId } as never);
    }

    async findByOwnerAndId(entityId: string, userId: string): Promise<WithId<S> | null> {
        return this._collection.findOne({ _id: entityId, user: userId } as never);
    }

    async replaceById(entityId: string, doc: S): Promise<void> {
        await this._collection.replaceOne({ _id: entityId } as never, doc, { upsert: true });
    }

    // protected so subclasses can still access the raw collection for operations not covered
    // by the generic helpers above (e.g. custom indexes, upsert by non-_id key)
    protected get collection() {
        return this._collection;
    }
}

export default AbstractDAO;

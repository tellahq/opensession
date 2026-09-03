# Subscription Gateway

Subscription Gateway will expose Claude and ChatGPT subscription accounts through an OpenAI-compatible local API. It is private while the account pool, provider adapters, and HTTP contract are being extracted and tested.

The first package layer contains no provider SDK or Open Session runtime code. It owns account routing, durable cooldowns, and retries that stop once an attempt emits client-visible output.

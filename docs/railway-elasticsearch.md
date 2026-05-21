# Railway Elasticsearch Service Setup

## Add ES to your Railway project

### 1. Create the service

In Railway dashboard → your Engram project → **New Service** → **Docker Image**:

```
docker.elastic.co/elasticsearch/elasticsearch:8.14.0
```

### 2. Environment variables (on the ES service)

```
discovery.type=single-node
xpack.security.enabled=false
ES_JAVA_OPTS=-Xms512m -Xmx512m
```

### 3. Volume

Attach a persistent volume at `/usr/share/elasticsearch/data` — Railway dashboard → Service → Volumes → Add.

### 4. Internal hostname

Railway assigns an internal hostname automatically. In Railway it'll be something like `elasticsearch.railway.internal`. Set on the **API service**:

```
ELASTICSEARCH_URL=http://elasticsearch.railway.internal:9200
```

No API key needed (security disabled for internal-only access). If you later enable xpack.security, add:
```
ELASTICSEARCH_API_KEY=<base64-encoded key>
```

### 5. Port

Expose port `9200` on the ES service (internal only — do NOT make it public).

---

## Elastic Cloud alternative (when you need managed)

If Railway costs or reliability become a concern, swap to Elastic Cloud Serverless:

1. Create deployment at cloud.elastic.co
2. Copy the **Elasticsearch endpoint URL** and an **API key**
3. Update API service env:
   ```
   ELASTICSEARCH_URL=https://<deployment>.es.us-east-1.aws.elastic.cloud
   ELASTICSEARCH_API_KEY=<base64 key>
   ```
4. No other code changes needed.

---

## Memory estimate

| Memories | ES heap | Railway plan |
|----------|---------|--------------|
| <50k     | 512MB   | Starter (~$5/mo) |
| 50k–200k | 1GB     | Pro (~$10/mo) |
| 200k+    | 2GB+    | Pro+ or Elastic Cloud |

Current Engram cloud: ~14k memories → 512MB heap is fine.

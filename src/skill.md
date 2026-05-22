## Extension: Voiden Scripting

Provides `pre_script` and `post_script` blocks for JavaScript, Python, or Shell (bash) execution before/after requests. Insert with `/pre-script` and `/post-script` slash commands.

### Block Structure

```yaml
---
type: pre_script          # or post_script
attrs:
  uid: "uid"
  language: javascript    # javascript | python | shell
  body: |
    ...your script here...
---
```

| `language` value | Runtime | Alias available |
|-----------------|---------|-----------------|
| `javascript` | Node.js worker | `voiden` and `vd` both work |
| `python` | Python subprocess | `voiden` and `vd` both work |
| `shell` | bash subprocess | `voiden` only — **`vd` does not exist in bash** |

- **pre_script** — runs before the HTTP request is sent; can modify `voiden.request.*`
- **post_script** — runs after the response arrives; can read `voiden.response.*`

The scripting object is always called `voiden`. In JavaScript and Python `vd` is an alias for the exact same object. In shell scripts there is no `vd` — only `voiden.xxx` bash functions are created.

---

### Language Syntax Comparison

The same operations written in each language:

#### Set a request header

```javascript
// JavaScript — assign a single header (replaces all)
voiden.request.headers = { key: "X-Token", value: "abc123" };
// assign multiple
voiden.request.headers = [{ key: "X-Token", value: "abc123" }, { key: "X-Foo", value: "bar" }];
// push appends without replacing existing headers
voiden.request.headers.push({ key: "X-Token", value: "abc123" });
```

```python
# Python — same assignment style
voiden.request.headers = {"key": "X-Token", "value": "abc123"}
# or a list
voiden.request.headers = [{"key": "X-Token", "value": "abc123"}, {"key": "X-Foo", "value": "bar"}]
```

```bash
# Shell — replace all / append
voiden.request.headers "X-Token" "abc123"       # replaces
voiden.request.headers.push "X-Token" "abc123"  # appends
```

#### Read / write the URL

```javascript
// JavaScript — property assignment
const old = voiden.request.url;
voiden.request.url = voiden.env.get("BASE_URL") + "/v2/users";
```

```python
# Python — property assignment
old = voiden.request.url
voiden.request.url = voiden.env.get("BASE_URL") + "/v2/users"
```

```bash
# Shell — function call (no args = getter, args = setter)
OLD_URL=$(voiden.request.url)
voiden.request.url "$(voiden.env.get BASE_URL)/v2/users"
# or via env var:
export VOIDEN_REQUEST_URL="https://new.example.com/api"
```

#### Set request body (JSON)

```javascript
// JavaScript
voiden.request.body = JSON.stringify({ name: "John", ts: Date.now() });
```

```python
# Python
import json
voiden.request.body = json.dumps({"name": "John"})
```

```bash
# Shell
voiden.request.body '{"name":"John"}'
```

#### Read response status + body

```javascript
// JavaScript — plain property access (no method calls)
const status = voiden.response.status;        // number
const body   = voiden.response.body;          // already parsed if JSON
const parsed = JSON.parse(voiden.response.body); // force parse
```

```python
# Python — plain property access
import json
status = voiden.response.status          # number
body   = json.loads(voiden.response.body)
```

```bash
# Shell — function calls that print to stdout
STATUS=$(voiden.response.status)
BODY=$(voiden.response.body)
# or via env vars:
echo "$VOIDEN_RESPONSE_STATUS"
echo "$VOIDEN_RESPONSE_BODY"
```

#### Get / set a variable

```javascript
// JavaScript
const token = voiden.variables.get("TOKEN");   // synchronous
voiden.variables.set("TOKEN", "new-value");
```

```python
# Python
token = voiden.variables.get("TOKEN")
voiden.variables.set("TOKEN", "new-value")
```

```bash
# Shell — space-separated args, no parentheses
TOKEN=$(voiden.variables.get "TOKEN")
voiden.variables.set "TOKEN" "new-value"
```

#### Assert

```javascript
// JavaScript — voiden.assert(actual, operator, expected, message?)
voiden.assert(voiden.response.status, "==", 200, "Expect 200 OK");
voiden.assert(voiden.response.time, "<", 500, "Under 500ms");
```

```python
# Python — voiden.assert_() because assert is a reserved keyword
voiden.assert_(voiden.response.status, "==", 200, "Expect 200 OK")
voiden.assert_(voiden.response.time, "<", 500, "Under 500ms")
```

```bash
# Shell — positional args: VALUE OPERATOR EXPECTED "message"
voiden.assert "$VOIDEN_RESPONSE_STATUS" "==" "200" "Expect 200 OK"
voiden.assert "$(voiden.response.time)" "<" "500" "Under 500ms"
```

#### Log

```javascript
// JavaScript
voiden.log("hello");               // log level
voiden.log("warn", "rate limit");  // explicit level
```

```python
# Python
voiden.log("hello")
voiden.log("warn", "rate limit")
```

```bash
# Shell
voiden.log "hello"
voiden.log "warn" "rate limit"
```

#### Cancel request (pre_script only)

```javascript
voiden.cancel();
```

```python
voiden.cancel()
```

```bash
voiden.cancel
```

---

### JavaScript API Reference

#### voiden.request (pre_script — read/write)

| Property / Call | Type | Description |
|-----------------|------|-------------|
| `voiden.request.url` | `string` | Request URL — read/write via assignment |
| `voiden.request.method` | `string` | HTTP method — read/write |
| `voiden.request.headers` | `{key,value,enabled?}[]` | Headers — assign `{key,value}`, `[{key,value},…]`, or a `{Name:val}` map to replace all |
| `voiden.request.headers.push({key, value, enabled?})` | — | Append one header without replacing existing |
| `voiden.request.body` | `any` | Body — read/write; must be a string for REST |
| `voiden.request.queryParams` | `{key,value,enabled?}[]` | Query params — assign to replace all |
| `voiden.request.queryParams.push({key, value, enabled?})` | — | Append one query param |
| `voiden.request.pathParams` | `{key,value,enabled?}[]` | Path params — assign to replace all |
| `voiden.request.pathParams.push({key, value, enabled?})` | — | Append one path param |

#### voiden.response (post_script — read-only)

| Property | Type | Description |
|----------|------|-------------|
| `voiden.response.status` | `number` | HTTP status code |
| `voiden.response.statusText` | `string` | HTTP status text (`"OK"`, `"Not Found"`, …) |
| `voiden.response.headers` | `Record<string,string>` | Response headers object |
| `voiden.response.body` | `any` | Response body — JSON object if parseable, otherwise string |
| `voiden.response.time` | `number` | Response time in ms |
| `voiden.response.size` | `number` | Response size in bytes |

#### voiden utilities

| Call | Description |
|------|-------------|
| `voiden.env.get(key)` | Get value from active environment |
| `voiden.variables.get(key)` | Get runtime variable (synchronous) |
| `voiden.variables.set(key, value)` | Set runtime variable — persists across requests |
| `voiden.log(...args)` | Log at `log` level |
| `voiden.log("warn", ...args)` | Log at `log` / `info` / `debug` / `warn` / `error` |
| `voiden.assert(actual, op, expected, msg?)` | Record structured assertion |
| `voiden.cancel()` | Cancel the request — pre_script only |

#### voiden.assert — Operators

| Operator(s) | Description |
|-------------|-------------|
| `"=="` / `"eq"` / `"equal"` | Loose equality |
| `"==="` | Strict equality |
| `"!="` / `"neq"` / `"notequal"` | Not equal |
| `">"` / `"greater"` / `"greaterthan"` | Numeric greater than |
| `">="` / `"gte"` | Greater than or equal |
| `"<"` / `"less"` / `"lessthan"` | Numeric less than |
| `"<="` / `"lte"` | Less than or equal |
| `"contains"` / `"includes"` | String or array contains |
| `"matches"` / `"regex"` | Regex match |
| `"truthy"` | Value is truthy |
| `"falsy"` | Value is falsy |

### JavaScript Patterns

```javascript
// pre_script: set a single header (replaces all headers)
voiden.request.headers = { key: "Authorization", value: "Bearer " + voiden.variables.get("ACCESS_TOKEN") };

// pre_script: append a header without replacing existing ones
voiden.request.headers.push({ key: "X-Request-ID", value: "abc123" });

// pre_script: set JSON body
voiden.request.body = JSON.stringify({ name: "John", ts: Date.now() });

// pre_script: build URL from env
voiden.request.url = voiden.env.get("BASE_URL") + "/users/" + voiden.variables.get("USER_ID");

// post_script: save token from login response
const data = voiden.response.body;  // already parsed if JSON
voiden.variables.set("ACCESS_TOKEN", data.access_token);
voiden.variables.set("REFRESH_TOKEN", data.refresh_token);

// post_script: full assertion suite
voiden.assert(voiden.response.status, "==", 200, "Status 200");
voiden.assert(voiden.response.time, "<", 500, "Under 500ms");
voiden.assert(voiden.response.body.id, "truthy", "", "Has ID");
voiden.assert(voiden.response.headers["content-type"], "contains", "application/json", "JSON response");
```

---

### Python API Reference

Python has the same property names as JavaScript. The one difference:
- Use `voiden.assert_(...)` — `assert` is a reserved keyword in Python
- Assign headers/params directly rather than using push

#### voiden.request (pre_script)

```python
voiden.request.url                           # read
voiden.request.url = "https://new.com"       # write

voiden.request.method                        # read
voiden.request.method = "POST"               # write

# Assign a single header (dict with key + value)
voiden.request.headers = {"key": "X-Foo", "value": "bar"}

# Or assign a list to set multiple at once
voiden.request.headers = [
    {"key": "Content-Type", "value": "application/json"},
    {"key": "X-Foo", "value": "bar"},
]

voiden.request.body                          # read
voiden.request.body = json.dumps({...})      # write — must be string

voiden.request.queryParams = {"key": "page", "value": "1"}
voiden.request.pathParams = {"key": "id", "value": "123"}
```

#### voiden.response (post_script)

```python
voiden.response.status       # int
voiden.response.statusText   # str
voiden.response.headers      # dict {name: value}
voiden.response.body         # str — use json.loads() to parse
voiden.response.time         # int ms
voiden.response.size         # int bytes
```

#### voiden utilities

```python
voiden.env.get("KEY")
voiden.variables.get("KEY")
voiden.variables.set("KEY", value)
voiden.log("message")
voiden.log("warn", "message")
voiden.assert_(actual, "==", expected, "message")   # NOT voiden.assert()
voiden.cancel()
```

### Python Patterns

```python
# pre_script
import json

token = voiden.variables.get("ACCESS_TOKEN")
voiden.request.headers = {"key": "Authorization", "value": f"Bearer {token}"}
voiden.request.body = json.dumps({"name": "John", "role": "admin"})

# post_script
import json

data = json.loads(voiden.response.body)
voiden.variables.set("CREATED_ID", str(data["id"]))

voiden.assert_(voiden.response.status, "==", 201, "Created")
voiden.assert_(voiden.response.time, "<", 1000, "Under 1s")
```

---

### Shell (Bash) API Reference

Shell scripts run in bash. The entire `voiden.*` API is injected as bash functions before your script runs. Call them with **space-separated arguments** and **no parentheses**. There is no `vd` alias — only `voiden.xxx`.

#### voiden.request (pre_script)

Calling a function with **no args returns (prints) the value**; calling with **args sets it**.

| Call | What it does |
|------|-------------|
| `voiden.request.url` | Print current URL |
| `voiden.request.url "https://..."` | Set URL |
| `voiden.request.method` | Print current method |
| `voiden.request.method "POST"` | Set method |
| `voiden.request.body` | Print current body |
| `voiden.request.body '{"k":"v"}'` | Set body |
| `voiden.request.headers` | Print headers as JSON array |
| `voiden.request.headers "Name" "Value"` | **Replace** all headers with one entry |
| `voiden.request.headers.push "Name" "Value"` | **Append** header (keeps existing) |
| `voiden.request.queryParams "key" "val"` | Replace all query params |
| `voiden.request.queryParams.push "key" "val"` | Append query param |
| `voiden.request.pathParams "key" "val"` | Replace all path params |
| `voiden.request.pathParams.push "key" "val"` | Append path param |

Direct env var write (alternative):

```bash
export VOIDEN_REQUEST_URL="https://new.example.com/api"
export VOIDEN_REQUEST_METHOD="DELETE"
export VOIDEN_REQUEST_BODY='{"confirm":true}'
```

#### voiden.response (post_script)

Functions print the value to stdout — capture with `$(...)`:

| Call | Returns |
|------|---------|
| `voiden.response.status` | HTTP status code |
| `voiden.response.statusText` | HTTP status text |
| `voiden.response.body` | Full response body string |
| `voiden.response.headers` | Headers as JSON `{"name":"value"}` |
| `voiden.response.time` | Time in ms |
| `voiden.response.size` | Size in bytes |

Env var equivalents: `$VOIDEN_RESPONSE_STATUS`, `$VOIDEN_RESPONSE_STATUS_TEXT`, `$VOIDEN_RESPONSE_BODY`, `$VOIDEN_RESPONSE_HEADERS`, `$VOIDEN_RESPONSE_TIME`, `$VOIDEN_RESPONSE_SIZE`

#### voiden.env / voiden.variables

| Call | Description |
|------|-------------|
| `voiden.env.get "KEY"` | Print env variable value |
| `voiden.variables.get "KEY"` | Print runtime variable value |
| `voiden.variables.set "KEY" "value"` | Set and persist runtime variable |

Underscore aliases also work: `voiden_env_get "KEY"`, `voiden_variables_get "KEY"`, `voiden_variables_set "KEY" "value"`

#### voiden utilities

| Call | Description |
|------|-------------|
| `voiden.log "message"` | Log at `log` level |
| `voiden.log "warn" "message"` | Log at level: `log` `info` `debug` `warn` `error` |
| `voiden.assert VALUE OP EXPECTED "msg"` | Record assertion |
| `voiden.cancel` | Cancel the pending request |

### Shell Patterns

```bash
# pre_script: build auth header from saved token
TOKEN=$(voiden.variables.get "ACCESS_TOKEN")
voiden.request.headers.push "Authorization" "Bearer $TOKEN"

# pre_script: set JSON body
voiden.request.body '{"name":"John","role":"admin"}'

# pre_script: build URL from env + variable
BASE=$(voiden.env.get "BASE_URL")
USER_ID=$(voiden.variables.get "USER_ID")
voiden.request.url "${BASE}/users/${USER_ID}"

# post_script: save token from login response (requires jq)
ACCESS_TOKEN=$(voiden.response.body | jq -r '.access_token')
voiden.variables.set "ACCESS_TOKEN" "$ACCESS_TOKEN"

# post_script: log and assert
STATUS=$(voiden.response.status)
voiden.log "info" "Response status: $STATUS"
voiden.assert "$STATUS" "==" "200" "Expect 200 OK"
voiden.assert "$(voiden.response.time)" "<" "500" "Under 500ms"

# post_script: assert a field from JSON body (requires jq)
USER_NAME=$(voiden.response.body | jq -r '.name')
voiden.assert "$USER_NAME" "==" "John" "Name matches"
```

#### Pre-loaded Shell Variables (full list)

Request (read/write via export or `voiden.request.*` functions):
- `$VOIDEN_REQUEST_URL`
- `$VOIDEN_REQUEST_METHOD`
- `$VOIDEN_REQUEST_BODY`
- `$VOIDEN_REQUEST_HEADERS` — JSON array `[{"key":"…","value":"…","enabled":true}]`
- `$VOIDEN_REQUEST_QUERY_PARAMS` — JSON array
- `$VOIDEN_REQUEST_PATH_PARAMS` — JSON array

Response (read-only, post_script only):
- `$VOIDEN_RESPONSE_STATUS`
- `$VOIDEN_RESPONSE_STATUS_TEXT`
- `$VOIDEN_RESPONSE_BODY`
- `$VOIDEN_RESPONSE_HEADERS` — JSON object `{"header-name":"value"}`
- `$VOIDEN_RESPONSE_TIME`
- `$VOIDEN_RESPONSE_SIZE`

Runtime variables (pre-loaded before script runs):
- Each variable named `KEY` is available as `$_VD_VAR_KEY` (prefer `voiden.variables.get "KEY"`)
- Each env file value named `KEY` is available as `$_VD_ENV_KEY` (prefer `voiden.env.get "KEY"`)

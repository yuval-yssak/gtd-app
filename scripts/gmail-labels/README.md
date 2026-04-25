# Gmail Label Manager

A CLI tool for managing Gmail labels — move messages between labels, rename labels, and reorganize label hierarchy.

## Setup

### 1. Google Cloud Project

1. Go to https://console.cloud.google.com/ and create a new project (e.g., "Gmail Label Manager")
2. Enable the **Gmail API**: APIs & Services > Library > search "Gmail API" > Enable
3. Configure OAuth consent screen: APIs & Services > OAuth consent screen > External > fill in app name + your email
4. Add your Gmail address as a **test user** under the OAuth consent screen settings
5. Create OAuth credentials: APIs & Services > Credentials > Create Credentials > OAuth client ID > Desktop app
6. Download `credentials.json` and place it in this directory (`scripts/gmail-labels/`)

### 2. Install Dependencies

```bash
pip3 install -r scripts/gmail-labels/requirements.txt
```

### 3. Authenticate

On first run, the script opens your browser for OAuth consent and saves a `token.json` for subsequent runs.

## Commands

### `list` — List all labels

```bash
python3 scripts/gmail-labels/gmail_labels.py list
```

```
  INBOX  (system, id=INBOX)
  Tickler File  (user, id=Label_6249131012446614969)
  Tickler File/Month 04 - April  (user, id=Label_4471767307141762529)
  Tickler File/Month 04 - April/06  (user, id=Label_7005848535635555752)
  ...
```

### `move-messages <source> <target>` — Move messages between labels

Moves all messages from the source label to the target label (adds target label, removes source label). Handles pagination for large mailboxes.

```bash
# Move tickler messages to inbox for today
python3 scripts/gmail-labels/gmail_labels.py move-messages "Tickler File/Month 04 - April/06" "INBOX"
Moved 4 message(s) from 'Tickler File/Month 04 - April/06' to 'INBOX'.

python3 scripts/gmail-labels/gmail_labels.py move-messages "Tickler File/Month 04 - April/10" "INBOX"
Moved 1 message(s) from 'Tickler File/Month 04 - April/10' to 'INBOX'.

# No-op when label has no messages
python3 scripts/gmail-labels/gmail_labels.py move-messages "Tickler File/Month 04 - April/08" "INBOX"
No messages found with label 'Tickler File/Month 04 - April/08'.
```

### `rename <old-name> <new-name>` — Rename a label

Renames a label and all its children (nested labels use "/" as separator).

```bash
python3 scripts/gmail-labels/gmail_labels.py rename "Projects" "Active Projects"
Renamed 'Projects' -> 'Active Projects'
  Renamed child 'Projects/Work' -> 'Active Projects/Work'
  Renamed child 'Projects/Personal' -> 'Active Projects/Personal'
```

### `move <label> <new-parent>` — Move a label under a new parent

Moves a label (and its children) under a different parent by renaming.

```bash
# Recycle day-of-month labels into next month after processing
python3 scripts/gmail-labels/gmail_labels.py move "Tickler File/Month 04 - April/06" "Tickler File/Month 05 - May"
Moved 'Tickler File/Month 04 - April/06' -> 'Tickler File/Month 05 - May/06'

python3 scripts/gmail-labels/gmail_labels.py move "Tickler File/Month 04 - April/07" "Tickler File/Month 05 - May"
Moved 'Tickler File/Month 04 - April/07' -> 'Tickler File/Month 05 - May/07'

python3 scripts/gmail-labels/gmail_labels.py move "Tickler File/Month 04 - April/08" "Tickler File/Month 05 - May"
Moved 'Tickler File/Month 04 - April/08' -> 'Tickler File/Month 05 - May/08'

python3 scripts/gmail-labels/gmail_labels.py move "Tickler File/Month 04 - April/09" "Tickler File/Month 05 - May"
Moved 'Tickler File/Month 04 - April/09' -> 'Tickler File/Month 05 - May/09'

python3 scripts/gmail-labels/gmail_labels.py move "Tickler File/Month 04 - April/10" "Tickler File/Month 05 - May"
Moved 'Tickler File/Month 04 - April/10' -> 'Tickler File/Month 05 - May/10'
```

## Typical Daily Workflow

Process today's tickler items by moving messages to inbox, then recycling the day label into next month:

```bash
# 1. Move today's messages to inbox
python3 scripts/gmail-labels/gmail_labels.py move-messages "Tickler File/Month 04 - April/09" "INBOX"

# 2. Move the day label to next month for reuse
python3 scripts/gmail-labels/gmail_labels.py move "Tickler File/Month 04 - April/09" "Tickler File/Month 05 - May"
```

#!/usr/bin/env python3
"""Gmail Label Manager — move messages, rename labels, reorganize hierarchy."""

import argparse
import os
import sys

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.labels", "https://www.googleapis.com/auth/gmail.modify"]
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_PATH = os.path.join(SCRIPT_DIR, "token.json")
CREDENTIALS_PATH = os.path.join(SCRIPT_DIR, "credentials.json")


def get_service():
    """Authenticate and return a Gmail API service instance."""
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_PATH):
                print(f"Error: {CREDENTIALS_PATH} not found.")
                print("Download it from Google Cloud Console > APIs & Services > Credentials.")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, "w") as token_file:
            token_file.write(creds.to_json())
    return build("gmail", "v1", credentials=creds)


def find_label(service, label_name):
    """Find a label by its exact name. Returns the label dict or None."""
    results = service.users().labels().list(userId="me").execute()
    for label in results.get("labels", []):
        if label["name"] == label_name:
            return label
    return None


def get_all_labels(service):
    """Return all labels sorted by name."""
    results = service.users().labels().list(userId="me").execute()
    return sorted(results.get("labels", []), key=lambda l: l["name"])


def list_labels(service):
    """Print all labels."""
    for label in get_all_labels(service):
        label_type = label.get("type", "user")
        print(f"  {label['name']}  ({label_type}, id={label['id']})")


def get_message_ids(service, label_id):
    """Get all message IDs for a label, handling pagination."""
    message_ids = []
    page_token = None
    while True:
        results = service.users().messages().list(
            userId="me", labelIds=[label_id], pageToken=page_token, maxResults=500
        ).execute()
        for msg in results.get("messages", []):
            message_ids.append(msg["id"])
        page_token = results.get("nextPageToken")
        if not page_token:
            break
    return message_ids


def move_messages(service, source_name, target_name):
    """Move all messages from source label to target label."""
    source = find_label(service, source_name)
    if not source:
        print(f"Error: source label '{source_name}' not found.")
        sys.exit(1)

    target = find_label(service, target_name)
    if not target:
        print(f"Error: target label '{target_name}' not found.")
        sys.exit(1)

    message_ids = get_message_ids(service, source["id"])
    if not message_ids:
        print(f"No messages found with label '{source_name}'.")
        return

    # batchModify handles up to 1000 messages per call
    batch_size = 1000
    for i in range(0, len(message_ids), batch_size):
        batch = message_ids[i : i + batch_size]
        service.users().messages().batchModify(
            userId="me",
            body={"ids": batch, "addLabelIds": [target["id"]], "removeLabelIds": [source["id"]]},
        ).execute()

    print(f"Moved {len(message_ids)} message(s) from '{source_name}' to '{target_name}'.")


def rename_label(service, old_name, new_name):
    """Rename a label and all its children."""
    label = find_label(service, old_name)
    if not label:
        print(f"Error: label '{old_name}' not found.")
        sys.exit(1)

    # Rename the label itself
    service.users().labels().update(
        userId="me", id=label["id"], body={**label, "name": new_name}
    ).execute()
    print(f"Renamed '{old_name}' -> '{new_name}'")

    # Rename children (labels whose name starts with "OldName/")
    rename_children(service, old_name, new_name)


def rename_children(service, old_prefix, new_prefix):
    """Rename all child labels by updating their name prefix."""
    child_prefix = old_prefix + "/"
    for label in get_all_labels(service):
        if label["name"].startswith(child_prefix):
            child_new_name = new_prefix + "/" + label["name"][len(child_prefix) :]
            service.users().labels().update(
                userId="me", id=label["id"], body={**label, "name": child_new_name}
            ).execute()
            print(f"  Renamed child '{label['name']}' -> '{child_new_name}'")


def move_label(service, label_name, new_parent):
    """Move a label under a new parent by renaming it."""
    label = find_label(service, label_name)
    if not label:
        print(f"Error: label '{label_name}' not found.")
        sys.exit(1)

    # Extract the leaf name (last segment after "/")
    leaf = label_name.rsplit("/", 1)[-1]
    new_name = f"{new_parent}/{leaf}"

    if find_label(service, new_name):
        print(f"Error: label '{new_name}' already exists.")
        sys.exit(1)

    service.users().labels().update(
        userId="me", id=label["id"], body={**label, "name": new_name}
    ).execute()
    print(f"Moved '{label_name}' -> '{new_name}'")

    rename_children(service, label_name, new_name)


def main():
    parser = argparse.ArgumentParser(description="Gmail Label Manager")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list", help="List all labels")

    move_msg_parser = subparsers.add_parser("move-messages", help="Move messages between labels")
    move_msg_parser.add_argument("source", help="Source label name")
    move_msg_parser.add_argument("target", help="Target label name")

    rename_parser = subparsers.add_parser("rename", help="Rename a label")
    rename_parser.add_argument("old_name", help="Current label name")
    rename_parser.add_argument("new_name", help="New label name")

    move_parser = subparsers.add_parser("move", help="Move a label under a new parent")
    move_parser.add_argument("label", help="Label to move")
    move_parser.add_argument("new_parent", help="New parent label name")

    args = parser.parse_args()
    service = get_service()

    if args.command == "list":
        list_labels(service)
    elif args.command == "move-messages":
        move_messages(service, args.source, args.target)
    elif args.command == "rename":
        rename_label(service, args.old_name, args.new_name)
    elif args.command == "move":
        move_label(service, args.label, args.new_parent)


if __name__ == "__main__":
    main()

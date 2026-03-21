import { useRef, KeyboardEvent, useState } from "react";
import dayjs from "dayjs";
import { useRouteContext } from "@tanstack/react-router";
import Button from "@mui/material/Button";
import ButtonGroup from "@mui/material/ButtonGroup";
import Snackbar from "@mui/material/Snackbar";
import TextField from "@mui/material/TextField";
import { GTDMainComponent } from "../components/basic/GTDComponentBlocks";
import { SyncOperation } from "../types/MyDB";

export function CollectPage() {
    const [justCollected, setJustCollected] = useState(false);
    const textRef = useRef<HTMLInputElement>(null);
    const { db, auth } = useRouteContext({ from: "/_authenticated/collect" });
    function clearAndFocusText() {
        if (!textRef.current) {
            return;
        }
        textRef.current.value = "";
        textRef.current.focus();
    }
    async function onCollect() {
        if (!textRef.current) {
            return;
        }

        const value = textRef.current.value.trim();
        if (value) {
            const newOperation: SyncOperation = {
                action: "add",
                itemId: crypto.randomUUID(),
                userId: auth.activeUser,
                payload: { title: value },
                synced: 0,
                uuid: `${dayjs().valueOf()}`,
            };
            await db.add("syncOperations", newOperation);
            // TODO: post message for service worker
            setJustCollected(true);
        }

        clearAndFocusText();
    }
    function onCancel() {
        clearAndFocusText();
    }
    function onTextKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCollect();
        }

        if (e.key === "Escape") {
            onCancel();
        }
    }

    return (
        <GTDMainComponent>
            <h2>Collect</h2>
            <TextField onKeyDown={onTextKeyDown} inputRef={textRef} autoFocus multiline placeholder="What is on your mind?" />
            <ButtonGroup>
                <Button onClick={onCollect}>Collect</Button>
                <Button onClick={onCancel}>Cancel</Button>
            </ButtonGroup>
            <Snackbar open={justCollected} message="Just collected" autoHideDuration={2000} onClose={() => setJustCollected(false)} />
        </GTDMainComponent>
    );
}

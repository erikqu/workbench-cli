import { dirname } from "node:path";
import { useMemo, useRef, useState } from "react";
import {
  Box,
  ModalDialog,
  Text,
  TextInput,
  type TextInputHandle,
  useInput,
} from "silvery";
import { requestClipboardPaste } from "../terminal/clipboard";
import { completeDirectories } from "../text/file-tree";
import { colors } from "../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

export function NewAgentDialog({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const [mode, setMode] = useState<"local" | "repository">("local");
  const [localValue, setLocalValue] = useState(
    defaultWorkspaceDirectory(view.cwd)
  );
  const [repositoryValue, setRepositoryValue] = useState("");
  const inputRef = useRef<TextInputHandle>(null);
  const suggestions = useMemo(
    () => (mode === "local" ? completeDirectories(localValue, view.cwd) : []),
    [localValue, mode, view.cwd]
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        actions.cancelNewAgent();
      }
      if ((key.ctrl || key.super) && input.toLowerCase() === "v") {
        requestClipboardPaste();
      }
      if (key.ctrl && input === "l") {
        setMode("local");
      }
      if (key.ctrl && input === "g") {
        setMode("repository");
      }
      if (mode === "local" && key.tab && suggestions[0]) {
        setLocalValue(withTrailingSlash(suggestions[0]));
      }
    },
    {
      // Silvery's TextInput owns readline-style keystrokes but does not consume
      // bracketed paste. Route the runtime's paste event into whichever field is
      // visible so native paste and the OSC-52 Ctrl/Cmd+V path behave alike.
      onPaste: (text) => {
        const input = inputRef.current;
        input?.setValue(`${input.getValue()}${text}`);
      },
    }
  );

  return (
    <Box
      alignItems="center"
      height="100%"
      justifyContent="center"
      left={0}
      onMouseDown={() => actions.cancelNewAgent()}
      position="absolute"
      top={0}
      width="100%"
    >
      <Box onMouseDown={(event) => event.stopPropagation()}>
        <ModalDialog
          borderColor={colors.borderFocus}
          footer="Enter confirm   Ctrl+L/G mode   Esc cancel"
          onClose={() => actions.cancelNewAgent()}
          title="New workspace"
          titleColor={colors.accentAlt}
          width={70}
        >
          <Box flexDirection="row" marginBottom={1}>
            <WorkspaceMode
              active={mode === "local"}
              label="Local folder"
              onSelect={() => setMode("local")}
            />
            <WorkspaceMode
              active={mode === "repository"}
              label="Clone GitHub repo"
              onSelect={() => setMode("repository")}
            />
          </Box>
          <Text color={colors.dim}>
            {mode === "local"
              ? "Workspace folder:"
              : "GitHub repository URL or SSH address:"}
          </Text>
          <TextInput
            color={colors.text}
            isActive
            key={mode}
            onChange={mode === "local" ? setLocalValue : setRepositoryValue}
            onSubmit={
              mode === "local"
                ? (next) => actions.createAgent(next)
                : (next) => actions.cloneRepository(next)
            }
            prompt="> "
            ref={inputRef}
            value={mode === "local" ? localValue : repositoryValue}
          />
          {suggestions.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {suggestions.map((suggestion) => (
                <SuggestionRow
                  key={suggestion}
                  onPick={() => {
                    setLocalValue(withTrailingSlash(suggestion));
                  }}
                  suggestion={suggestion}
                />
              ))}
            </Box>
          ) : null}
        </ModalDialog>
      </Box>
    </Box>
  );
}

function WorkspaceMode({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect(): void;
}) {
  return (
    <Box
      backgroundColor={active ? colors.selected : colors.panel}
      mouseCursor="pointer"
      onClick={(event) => {
        if (event.button === 0) {
          onSelect();
          event.stopPropagation();
        }
      }}
      paddingX={1}
    >
      <Text color={active ? colors.onSelected : colors.dim}>{label}</Text>
    </Box>
  );
}

function SuggestionRow({
  suggestion,
  onPick,
}: {
  suggestion: string;
  onPick(): void;
}) {
  const click = (event: { stopPropagation(): void }) => {
    onPick();
    event.stopPropagation();
  };

  return (
    <Box backgroundColor={colors.panel} height={1} onClick={click}>
      <Text color={colors.dim}>{`  ${suggestion}`}</Text>
    </Box>
  );
}

function withTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

export function defaultWorkspaceDirectory(cwd: string): string {
  return withTrailingSlash(dirname(cwd));
}

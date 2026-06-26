import { useMemo, useState } from "react";
import { Box, ModalDialog, Text, TextInput, useInput } from "silvery";
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
  const [value, setValue] = useState(view.cwd);
  const suggestions = useMemo(
    () => completeDirectories(value, view.cwd),
    [value, view.cwd]
  );

  useInput((_input, key) => {
    if (key.escape) {
      actions.cancelNewAgent();
    }
    if (key.tab && suggestions[0]) {
      setValue(withTrailingSlash(suggestions[0]));
    }
  });

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
          footer="Enter create   Tab complete first suggestion   Esc cancel"
          onClose={() => actions.cancelNewAgent()}
          title="New workspace"
          titleColor={colors.accentAlt}
          width={70}
        >
          <Text color={colors.dim}>Workspace folder:</Text>
          <TextInput
            color={colors.text}
            isActive
            onChange={setValue}
            onSubmit={(next) => actions.createAgent(next)}
            prompt="> "
            value={value}
          />
          {suggestions.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {suggestions.map((suggestion) => (
                <SuggestionRow
                  key={suggestion}
                  onPick={() => {
                    setValue(withTrailingSlash(suggestion));
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

import { Box, ModalDialog, SelectList, Text, useInput } from "silvery";
import { colors } from "../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

export function NewHarnessDialog({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const activeId = activeHarnessId(view);
  const initialIndex = Math.max(
    0,
    view.harnessSpecs.findIndex((spec) => spec.id === activeId)
  );
  const items = view.harnessSpecs.map((spec) => ({
    label: `${spec.label}${view.session.harnesses.some((harness) => harness.harnessId === spec.id) ? "  open" : "  new"}  ${spec.description}`,
    value: spec.id,
  }));

  useInput((_input, key) => {
    if (key.escape) {
      actions.cancelNewHarness();
    }
  });

  return (
    <Box
      height="100%"
      left={0}
      onMouseDown={() => actions.cancelNewHarness()}
      position="absolute"
      top={0}
      width="100%"
    >
      <Box
        onMouseDown={(event) => event.stopPropagation()}
        position="absolute"
        right={6}
        top={2}
      >
        <ModalDialog
          borderColor={colors.borderFocus}
          footer="Enter start/switch   Up/Down choose   Esc cancel"
          onClose={() => actions.cancelNewHarness()}
          title="Switch CLI harness"
          titleColor={colors.accentAlt}
          width={74}
        >
          <Text color={colors.dim}>Pick a harness for this workspace:</Text>
          <SelectList
            indicator="> "
            initialIndex={initialIndex}
            isActive
            items={items}
            maxVisible={12}
            onSelect={(item) => actions.addHarness(item.value)}
          />
        </ModalDialog>
      </Box>
    </Box>
  );
}

function activeHarnessId(view: WorkbenchViewModel) {
  const active = view.session.harnesses.find(
    (harness) => `harness:${harness.id}` === view.session.activeMainTab
  );
  return active?.harnessId ?? view.session.harnesses[0]?.harnessId;
}

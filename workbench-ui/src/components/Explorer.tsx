import { useMemo } from "react";
import {
  Box,
  Text,
  type TreeNode,
  TreeView,
  useBoxRectDangerously,
} from "silvery";
import type { FileTreeEntry } from "../state/types";
import { colors } from "../ui/theme";
import type {
  SelectOption,
  WorkbenchActions,
  WorkbenchViewModel,
} from "./types";

export function Explorer({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const focused = view.state.focus === "explorer";
  const options = view.explorerOptions;
  const { tree, byPath } = useMemo(() => buildTree(options), [options]);
  const expandedIds = useMemo(
    () =>
      new Set(
        options
          .filter((option) => option.value.isDirectory && option.value.expanded)
          .map((option) => option.value.path)
      ),
    [options]
  );

  const select = (id: string) => {
    const option = byPath.get(id);
    if (option) {
      actions.selectExplorer(option);
    }
  };

  return (
    <Box
      backgroundColor={colors.panel}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      onMouseDown={(event) => {
        actions.focus("explorer");
        event.stopPropagation();
      }}
      padding={1}
      width={30}
    >
      <Box flexDirection="row" height={1} justifyContent="space-between">
        <Text color={colors.dim}>Explorer</Text>
        <Text color={colors.dim}>{String(options.length)}</Text>
      </Box>
      <ExplorerBody
        active={focused}
        expandedIds={expandedIds}
        onActivate={select}
        tree={tree}
      />
    </Box>
  );
}

export function ExplorerSection({
  view,
  actions,
  height,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  height: number;
}) {
  const focused = view.state.focus === "explorer";
  const options = view.explorerOptions;
  const { tree, byPath } = useMemo(() => buildTree(options), [options]);
  const expandedIds = useMemo(
    () =>
      new Set(
        options
          .filter((option) => option.value.isDirectory && option.value.expanded)
          .map((option) => option.value.path)
      ),
    [options]
  );

  const select = (id: string) => {
    const option = byPath.get(id);
    if (option) {
      actions.selectExplorer(option);
    }
  };

  return (
    <Box
      flexDirection="column"
      flexShrink={1}
      height={height}
      minHeight={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("explorer");
        event.stopPropagation();
      }}
      overflow="hidden"
    >
      <Box
        backgroundColor={colors.panelAlt}
        flexDirection="row"
        flexShrink={0}
        height={1}
        justifyContent="space-between"
        paddingX={1}
      >
        <Text color={colors.accentAlt}>Explorer</Text>
        <Text color={colors.dim}>{String(options.length)}</Text>
      </Box>
      <ExplorerBody
        active={focused}
        expandedIds={expandedIds}
        onActivate={select}
        tree={tree}
      />
    </Box>
  );
}

function ExplorerBody({
  tree,
  expandedIds,
  active,
  onActivate,
}: {
  tree: TreeNode[];
  expandedIds: Set<string>;
  active: boolean;
  onActivate(id: string): void;
}) {
  return (
    <Box flexGrow={1} minWidth={1}>
      <ExplorerTree
        active={active}
        expandedIds={expandedIds}
        onActivate={onActivate}
        tree={tree}
      />
    </Box>
  );
}

// TreeView owns flattening, indentation, the expand glyph, keyboard nav, and
// expand/collapse (arrows/Enter -> onToggle). It has no leaf-select callback, so
// files open via a renderNode onClick. selectExplorer already routes dirs to a
// toggle and files to "open", so both paths funnel through it.
function ExplorerTree({
  tree,
  expandedIds,
  active,
  onActivate,
}: {
  tree: TreeNode[];
  expandedIds: Set<string>;
  active: boolean;
  onActivate(id: string): void;
}) {
  const rect = useBoxRectDangerously();
  const height = Math.max(1, Math.floor(rect.height));
  return (
    <TreeView
      data={tree}
      expandedIds={expandedIds}
      height={height}
      isActive={active}
      onToggle={(id) => onActivate(id)}
      renderNode={(node) =>
        node.children ? (
          <Text color={colors.text} wrap={false}>
            {node.label}
          </Text>
        ) : (
          <Text
            color={colors.text}
            onClick={(event) => {
              onActivate(node.id);
              event.stopPropagation();
            }}
            wrap={false}
          >
            {node.label}
          </Text>
        )
      }
    />
  );
}

// Rebuild the nested TreeNode[] from the flattened, depth-ordered explorer
// entries. Lazy loading is preserved: a collapsed directory keeps an unread
// sentinel child purely so TreeView shows its expand glyph; TreeView never
// descends a collapsed node, so the sentinel is never rendered, and expanding
// triggers onToggle -> a real directory read that replaces it.
function buildTree(options: SelectOption<FileTreeEntry>[]): {
  tree: TreeNode[];
  byPath: Map<string, SelectOption<FileTreeEntry>>;
} {
  const tree: TreeNode[] = [];
  const byPath = new Map<string, SelectOption<FileTreeEntry>>();
  const stack: { depth: number; children: TreeNode[] }[] = [
    { depth: -1, children: tree },
  ];

  for (const option of options) {
    const entry = option.value;
    byPath.set(entry.path, option);
    while (stack.length > 1 && stack[stack.length - 1].depth >= entry.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].children;
    const node: TreeNode = { id: entry.path, label: entry.name };
    if (entry.isDirectory) {
      node.children = entry.expanded
        ? []
        : [{ id: `${entry.path}::__sentinel__`, label: "" }];
    }
    parent.push(node);
    if (entry.isDirectory && entry.expanded) {
      stack.push({ depth: entry.depth, children: node.children! });
    }
  }

  return { tree, byPath };
}

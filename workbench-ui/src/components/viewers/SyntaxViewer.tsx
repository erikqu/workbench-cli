import { relative } from "node:path";
import { Box, H1, HR, Kbd, Muted, P } from "silvery";
import { colors } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { ImageViewer } from "./ImageViewer";
import { MarkdownViewer } from "./MarkdownViewer";
import { PdfViewer } from "./PdfViewer";
import { activeFileTab } from "./shared";
import { FileEditor, ReadOnlyViewer } from "./TextEditor";
import { VideoViewer } from "./VideoViewer";

export { SuppressImagesContext } from "./shared";

export function SyntaxViewer({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const tab = activeFileTab(view);

  if (!tab) {
    return (
      <Box
        backgroundColor={colors.editor}
        borderColor={colors.border}
        borderStyle="single"
        flexDirection="column"
        flexGrow={1}
        padding={1}
      >
        <H1>Workbench</H1>
        <HR />
        <P wrap="wrap">
          A terminal IDE for running coding agents alongside your files.
        </P>
        <Box flexDirection="column" marginTop={1}>
          <P wrap="wrap">
            <Muted>Open a file from the </Muted>Explorer
            <Muted> to preview it here.</Muted>
          </P>
          <P wrap="wrap">
            <Muted>Use harness tabs to run coding agents, or press </Muted>
            <Kbd>Ctrl+T</Kbd>
            <Muted> for a terminal.</Muted>
          </P>
        </Box>
      </Box>
    );
  }

  const rel = relative(view.cwd, tab.path);
  const suffix = tab.truncated ? "\n\n... truncated ..." : "";

  if (tab.kind === "image") {
    return (
      <ImageViewer
        actions={actions}
        key={tab.path}
        rel={rel}
        tab={tab}
        view={view}
      />
    );
  }

  if (tab.kind === "video") {
    return (
      <VideoViewer
        actions={actions}
        key={tab.path}
        rel={rel}
        tab={tab}
        view={view}
      />
    );
  }

  if (tab.kind === "pdf") {
    return (
      <PdfViewer
        actions={actions}
        key={tab.path}
        rel={rel}
        tab={tab}
        view={view}
      />
    );
  }

  if (tab.kind === "markdown" && !tab.binary && !tab.truncated) {
    return (
      <MarkdownViewer
        actions={actions}
        key={tab.path}
        rel={rel}
        tab={tab}
        view={view}
      />
    );
  }

  if (tab.binary || tab.truncated) {
    return (
      <ReadOnlyViewer
        actions={actions}
        content={tab.binary ? "(binary file)" : `${tab.content}${suffix}`}
        key={tab.path}
        rel={rel}
        tab={tab}
        view={view}
      />
    );
  }

  return (
    <FileEditor
      actions={actions}
      key={tab.path}
      rel={rel}
      tab={tab}
      view={view}
    />
  );
}

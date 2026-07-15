import { useEffect, useState } from "react";
import { Box, Text, useBoxRectDangerously, useInput } from "silvery";
import { type PdfPreview, preparePdfPreview } from "../../media/pdf";
import type { EditorTab } from "../../state/types";
import { colors } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { MeasuredImageContent } from "./ImageViewer";
import { clamp } from "./shared";

export function PdfViewer({
  tab,
  rel,
  view,
  actions,
}: {
  tab: EditorTab;
  rel: string;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | undefined>(undefined);
  const focused = view.state.focus === "editor";
  const changePage = (delta: number) => {
    setPage((current) =>
      clamp(current + delta, 1, pageCount ?? Number.MAX_SAFE_INTEGER)
    );
  };

  useInput((_input, key) => {
    if (!focused) {
      return;
    }
    if (key.pageUp || key.upArrow) {
      changePage(-1);
    }
    if (key.pageDown || key.downArrow) {
      changePage(1);
    }
  });

  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("editor");
        event.stopPropagation();
      }}
      onWheel={(event) => {
        changePage(event.deltaY > 0 ? 1 : -1);
        event.preventDefault();
        event.stopPropagation();
      }}
      padding={1}
    >
      <Box flexDirection="row" height={1} justifyContent="space-between">
        <Text color={colors.dim}>{rel}</Text>
        <Text
          color={colors.dim}
        >{`PDF page ${page}${pageCount ? ` / ${pageCount}` : ""}  ↑↓/PgUp/PgDn`}</Text>
      </Box>
      <Box
        backgroundColor={colors.panelAlt}
        flexGrow={1}
        minWidth={1}
        overflow="hidden"
      >
        <MeasuredPdfContent
          page={page}
          path={tab.path}
          setPage={setPage}
          setPageCount={setPageCount}
        />
      </Box>
    </Box>
  );
}

function MeasuredPdfContent({
  path,
  page,
  setPage,
  setPageCount,
}: {
  path: string;
  page: number;
  setPage(page: number | ((current: number) => number)): void;
  setPageCount(pageCount: number | undefined): void;
}) {
  const rect = useBoxRectDangerously();
  const cols = Math.max(1, Math.floor(rect.width));
  const [preview, setPreview] = useState<PdfPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPreview(null);
    const timer = setTimeout(() => {
      preparePdfPreview(path, page, cols)
        .then((result) => {
          if (cancelled) {
            return;
          }
          setPreview(result);
          setPageCount(result.pageCount);
          if (result.page !== page) {
            setPage(result.page);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setPreview(null);
            setError(
              err instanceof Error ? err.message : "Could not render PDF"
            );
          }
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, page, cols, setPage, setPageCount]);

  if (error) {
    return <Text color={colors.accentAlt}>{error}</Text>;
  }
  if (!preview) {
    return <Text color={colors.dim}>Rendering PDF...</Text>;
  }
  return <MeasuredImageContent path={preview.imagePath} />;
}

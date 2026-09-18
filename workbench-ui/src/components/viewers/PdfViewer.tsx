import { useEffect, useRef, useState } from "react";
import { Box, Text, useBoxRectDangerously, useInput } from "silvery";
import {
  forgetImage,
  prepareSilveryImage,
  type SilveryImagePlacement,
} from "../../media/image";
import { type PdfPreview, preparePdfPreview } from "../../media/pdf";
import { PdfPageLoader } from "../../media/pdf-page-loader";
import type { EditorTab } from "../../state/types";
import { colors } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { PreparedImageContent } from "./ImageViewer";
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

type ReadyPdfPreview = PdfPreview & {
  sourcePath: string;
  placement: SilveryImagePlacement;
};

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
  // Small pane drags can reuse the same raster and let the image fit itself.
  const cols = Math.max(1, Math.ceil(rect.width / 8) * 8);
  const imageCols = Math.max(1, Math.floor(rect.width));
  const rows = Math.max(1, Math.floor(rect.height));
  const [preview, setPreview] = useState<ReadyPdfPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loader = useRef<{
    key: string;
    pages: PdfPageLoader<ReadyPdfPreview>;
  } | null>(null);
  const key = JSON.stringify([path, imageCols, rows]);

  useEffect(() => {
    const current = new PdfPageLoader(async (requestedPage, signal) => {
      const result = await preparePdfPreview(path, requestedPage, cols, signal);
      try {
        let placement = await prepareSilveryImage(
          result.imagePath,
          imageCols,
          rows
        );
        signal.throwIfAborted();
        if (!placement) {
          throw new Error("Could not decode PDF page");
        }
        if (
          placement.protocol === "graphics" &&
          typeof placement.src === "string"
        ) {
          placement = {
            ...placement,
            src: Buffer.from(await Bun.file(placement.src).arrayBuffer()),
          };
          signal.throwIfAborted();
        }
        return { ...result, sourcePath: path, placement };
      } finally {
        forgetImage(result.imagePath);
      }
    });
    loader.current = { key, pages: current };
    return () => {
      current.dispose();
      loader.current = null;
    };
  }, [path, cols, imageCols, rows, key]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loader.current?.pages
      .load(page)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setPreview({ ...result, sourcePath: path });
        setPageCount(result.pageCount);
        if (result.page !== page) {
          setPage(result.page);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview(null);
          setError(err instanceof Error ? err.message : "Could not render PDF");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, page, cols, key, setPage, setPageCount]);

  if (error) {
    return <Text color={colors.accentAlt}>{error}</Text>;
  }
  const visible =
    (loader.current?.key === key
      ? loader.current.pages.peek(page)
      : undefined) ?? preview;
  if (!visible || visible.sourcePath !== path || visible.page !== page) {
    return <Text color={colors.dim}>Rendering PDF...</Text>;
  }
  return <PreparedImageContent placement={visible.placement} />;
}

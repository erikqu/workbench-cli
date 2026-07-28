# Diagram

A short paragraph before the diagram.

## Wide table bounds

| Short | A deliberately oversized table column that must stay inside the preview pane | Tail |
| --- | --- | --- |
| alpha | WIDE_TABLE_CELL_ABCDEFGHIJKLMNOPQRSTUVWXYZ_ABCDEFGHIJKLMNOPQRSTUVWXYZ_ABCDEFGHIJKLMNOPQRSTUVWXYZ_ABCDEFGHIJKLMNOPQRSTUVWXYZ_ABCDEFGHIJKLMNOPQRSTUVWXYZ | omega |

```mermaid
graph TD
  A[Start] --> B{Is it working?}
  B -- Yes --> C[Ship it]
  B -- No --> D[Debug]
  D --> B
```

Text after the diagram.

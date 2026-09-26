import OpenTUI

// TextTable fed from a model, plus a Slider controlling how many rows are shown.
Window {
    id: root
    color: "#1a1b26"

    property var services: [
        { name: "api", status: "up", latency: 12 },
        { name: "db", status: "up", latency: 3 },
        { name: "cache", status: "degraded", latency: 48 },
        { name: "queue", status: "up", latency: 7 },
        { name: "search", status: "down", latency: 0 }
    ]
    property int shown: 3

    Keys.onPressed: (event) => {
        switch (event.key) {
            case "left": case "h": shown = Math.max(1, shown - 1); break
            case "right": case "l": shown = Math.min(services.length, shown + 1); break
            case "q": case "escape": Qt.quit(); break
        }
    }

    Column {
        padding: 1
        gap: 1

        Text { text: "Services (" + root.shown + " of " + root.services.length + ")"; color: "#7aa2f7"; font.bold: true }

        TextTable {
            model: root.services.slice(0, root.shown)
            columns: ["name", "status", "latency"]
            headers: ["Service", "Status", "Latency (ms)"]
            borderColor: "#414868"
            color: "#c0caf5"
            cellPaddingX: 1
        }

        Row {
            gap: 1
            Text { text: "Rows:"; color: "#c0caf5" }
            Slider {
                width: 30
                height: 1
                from: 1
                to: root.services.length
                viewPortSize: 1
                value: root.shown
                backgroundColor: "#24283b"
                foregroundColor: "#7aa2f7"
                onMoved: (value) => root.shown = Math.round(value)
            }
        }

        Text { text: "←/→ or h/l (or drag the slider) · q to quit"; color: "#565f89" }
    }
}

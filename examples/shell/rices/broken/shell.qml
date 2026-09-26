import OpenTUI
import Demo.Bricks

// A user shell with a syntax error: the app falls back to the default shell and shows the
// error overlay. Fix it (close the Card) while the app runs and it hot-reloads.
ShellWindow {
    Card {
        heading: "never shown"
        Text { text: "unterminated" + }
}

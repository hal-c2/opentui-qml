pragma Singleton
import OpenTUI

// Colours for the bricks, read from the app's `Theme` store (reactive: the app can restyle
// at run time). A shell can also override any brick's colour properties directly.
QtObject {
    readonly property string chrome: Theme.colors.chrome
    readonly property string surface: Theme.colors.surface
    readonly property string text: Theme.colors.text
    readonly property string muted: Theme.colors.muted
    readonly property string accent: Theme.colors.accent
    readonly property string border: Theme.colors.border
    readonly property int radius: Theme.radius
}

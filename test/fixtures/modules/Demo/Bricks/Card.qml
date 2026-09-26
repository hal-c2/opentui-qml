import OpenTUI

// Card 1.0: a titled container brick.
Rectangle {
    id: card
    property string heading: "Card"
    property alias headingText: titleText.text
    property alias body: inner
    default property alias content: inner.data
    property int version: 1
    property string accent: Theme.accent
    property int doubled: Util.twice(21)
    property QtObject helper: Helper { }
    flexDirection: "column"
    Text { id: titleText; text: card.heading }
    Column { id: inner }
}

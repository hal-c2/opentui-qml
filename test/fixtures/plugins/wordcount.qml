// A QML plugin: contributes a word counter to the "status" slot.
Plugin {
    pluginId: "wordcount"
    order: 5
    types: ["./Badge.qml"]

    Contribution {
        slot: "status"
        TestText { text: "words: " + data.words }
    }

    Component.onCompleted: log.push("wordcount setup")
    Component.onDestruction: log.push("wordcount dispose")
}

.pragma library
.import "other.js" as Other

var counter = 0
function next() {
    counter += 1
    return counter
}
function label(name) {
    return qsTr("Hello ") + name
}

// macOS 26 draws a menu-bar "recording" dot from a background thread and then
// aborts. The dot is not needed: Second Brain has its own Stop button.
// Skipping that menu-bar setup lets the recording finish.
// screen.js compiles this together with screenrec.swift.

#import <Foundation/Foundation.h>
#import <objc/runtime.h>

static void skipDot(id self, SEL cmd, id stream) {
    (void)self;
    (void)cmd;
    (void)stream;
}

void skipRecordingMenuDot(void) {
    Class cls = NSClassFromString(@"SCStatusItem");
    SEL sel = NSSelectorFromString(@"setupSystemStatusItemWithOneStream:");
    Method method = cls ? class_getInstanceMethod(cls, sel) : NULL;
    if (!method) {
        fputs("The recording menu-bar dot could not be turned off.\n", stderr);
        return;
    }
    method_setImplementation(method, (IMP)skipDot);
}

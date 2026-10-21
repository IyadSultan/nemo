/*
 * Read this Mac's fan speed from the SMC chip.
 *
 * The SMC (System Management Controller) is the small chip that runs
 * the fans. A program asks it for a four-letter name:
 *   FNum  how many fans this Mac has
 *   F0Ac  fan 0 speed right now, in revolutions per minute
 *   F0Mn  the slowest that fan is allowed to spin
 *   F0Mx  the fastest that fan is allowed to spin
 * Fan 1 uses F1Ac, F1Mn, and F1Mx. On a MacBook Pro, fan 0 is the
 * left fan and fan 1 is the right fan.
 *
 * Speeds and temperatures are stored as ordinary decimal numbers
 * (the type name is "flt "), already in this Mac's byte order.
 *
 * Prints one line of JSON, then exits.
 */

#include <IOKit/IOKitLib.h>
#include <stdio.h>
#include <string.h>

#define KERNEL_INDEX_SMC 2
#define SMC_CMD_READ_BYTES 5
#define SMC_CMD_READ_KEYINFO 9

typedef struct {
    char major;
    char minor;
    char build;
    char reserved[1];
    UInt16 release;
} SMCKeyData_vers_t;

typedef struct {
    UInt16 version;
    UInt16 length;
    UInt32 cpuPLimit;
    UInt32 gpuPLimit;
    UInt32 memPLimit;
} SMCKeyData_pLimitData_t;

typedef struct {
    UInt32 dataSize;
    UInt32 dataType;
    char dataAttributes;
} SMCKeyData_keyInfo_t;

typedef char SMCBytes_t[32];

typedef struct {
    UInt32 key;
    SMCKeyData_vers_t vers;
    SMCKeyData_pLimitData_t pLimitData;
    SMCKeyData_keyInfo_t keyInfo;
    char result;
    char status;
    char data8;
    UInt32 data32;
    SMCBytes_t bytes;
} SMCKeyData_t;

static io_connect_t conn = 0;

/* Turn the four letters "F0Ac" into the number the chip expects. */
static UInt32 fourcc(const char *key) {
    return ((UInt32)key[0] << 24) + ((UInt32)key[1] << 16) +
           ((UInt32)key[2] << 8) + (UInt32)key[3];
}

static kern_return_t call_smc(SMCKeyData_t *input, SMCKeyData_t *output) {
    size_t out_size = sizeof(SMCKeyData_t);
    memset(output, 0, sizeof(*output));
    return IOConnectCallStructMethod(conn, KERNEL_INDEX_SMC, input, sizeof(*input), output, &out_size);
}

/* Ask for one key. The value lands in out->bytes. */
static kern_return_t read_key(const char *key, SMCKeyData_t *out) {
    SMCKeyData_t input;
    SMCKeyData_t info;
    memset(&input, 0, sizeof(input));
    input.key = fourcc(key);
    input.data8 = SMC_CMD_READ_KEYINFO;
    kern_return_t result = call_smc(&input, &info);
    if (result != kIOReturnSuccess) return result;
    if (info.keyInfo.dataSize == 0 || info.keyInfo.dataSize > sizeof(info.bytes)) {
        return kIOReturnNotFound;
    }
    memset(&input, 0, sizeof(input));
    input.key = fourcc(key);
    input.keyInfo.dataSize = info.keyInfo.dataSize;
    input.data8 = SMC_CMD_READ_BYTES;
    result = call_smc(&input, out);
    if (result != kIOReturnSuccess) return result;
    out->keyInfo = info.keyInfo;
    return kIOReturnSuccess;
}

/* A "flt " value is a 4-byte decimal number in the Mac's byte order. */
static int read_float(const char *key, double *value) {
    SMCKeyData_t out;
    if (read_key(key, &out) != kIOReturnSuccess) return -1;
    if (out.keyInfo.dataSize < 4) return -1;
    float number;
    memcpy(&number, out.bytes, sizeof(number));
    if (number < 0 || number > 200000) return -1;
    *value = (double)number;
    return 0;
}

static int open_smc(void) {
    io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
    if (!service) return -1;
    kern_return_t result = IOServiceOpen(service, mach_task_self(), 0, &conn);
    IOObjectRelease(service);
    return result == kIOReturnSuccess ? 0 : -1;
}

int main(void) {
    if (open_smc() != 0) {
        printf("{\"ok\":false,\"error\":\"The fan chip did not open.\"}\n");
        return 0;
    }

    int count = 0;
    SMCKeyData_t count_key;
    if (read_key("FNum", &count_key) == kIOReturnSuccess && count_key.keyInfo.dataSize >= 1) {
        count = (unsigned char)count_key.bytes[0];
    }
    if (count < 0) count = 0;
    if (count > 4) count = 4;

    printf("{\"ok\":true,\"fans\":[");
    for (int i = 0; i < count; i++) {
        char key[5];
        double rpm = -1;
        double min_rpm = -1;
        double max_rpm = -1;
        snprintf(key, sizeof(key), "F%dAc", i);
        read_float(key, &rpm);
        snprintf(key, sizeof(key), "F%dMn", i);
        read_float(key, &min_rpm);
        snprintf(key, sizeof(key), "F%dMx", i);
        read_float(key, &max_rpm);
        if (i) printf(",");
        printf("{\"index\":%d,\"rpm\":%.0f,\"min\":%.0f,\"max\":%.0f}", i, rpm, min_rpm, max_rpm);
    }

    /* Three temperatures a person can recognise. Missing ones are skipped. */
    const char *temps[][2] = {
        {"Tp00", "CPU"},
        {"Tg08", "GPU"},
        {"TB0T", "Battery"},
        {NULL, NULL},
    };
    printf("],\"temps\":[");
    int printed = 0;
    for (int i = 0; temps[i][0]; i++) {
        double celsius = -1;
        if (read_float(temps[i][0], &celsius) != 0) continue;
        if (celsius < 5 || celsius > 120) continue;
        if (printed) printf(",");
        printf("{\"name\":\"%s\",\"c\":%.1f}", temps[i][1], celsius);
        printed++;
    }
    printf("]}\n");

    IOServiceClose(conn);
    return 0;
}

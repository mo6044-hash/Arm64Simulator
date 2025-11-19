// ARM64 Assembly Simulator

class ARM64Simulator {
    constructor() {
        this.reset();
    }

    reset() {
        // Fixed ARM64 memory layout
        this.memoryLayout = {
            rodata: { start: 0x00100000n, end: 0x001FFFFFn, name: 'Rodata', readonly: true },
            data: { start: 0x00200000n, end: 0x002FFFFFn, name: 'Data', readonly: false },
            bss: { start: 0x00300000n, end: 0x003FFFFFn, name: 'BSS', readonly: false },
            heap: { start: 0x00400000n, end: 0x07FEFFFFn, name: 'Heap', readonly: false },
            stack: { start: 0x07FF0000n, end: 0x07FFFFFFn, name: 'Stack', readonly: false }
        };
        
        // Calculate 16-byte aligned initial SP (highest address <= STACK_END that is 16-byte aligned)
        const STACK_END = this.memoryLayout.stack.end;
        const initialSp = (STACK_END + 1n) & ~0xFn; // Align to 16 bytes
        
        // Initialize registers
        this.registers = {
            x0: 0n, x1: 0n, x2: 0n, x3: 0n, x4: 0n, x5: 0n, x6: 0n, x7: 0n,
            x8: 0n, x9: 0n, x10: 0n, x11: 0n, x12: 0n, x13: 0n, x14: 0n, x15: 0n,
            x16: 0n, x17: 0n, x18: 0n, x19: 0n, x20: 0n, x21: 0n, x22: 0n, x23: 0n,
            x24: 0n, x25: 0n, x26: 0n, x27: 0n, x28: 0n, x29: 0n, x30: 0n,
            sp: initialSp,  // Initial stack pointer (16-byte aligned)
            lr: 0n,
            pc: 0n
        };

        // Memory: byte-addressable, stores 64-bit values
        this.memory = new Map();
        
        // Heap allocator (bump pointer)
        this.heapPtr = 0x00400000n;
        
        // Labels for ADR/ADRP resolution
        this.labels = new Map();
        
        // Program instructions
        this.instructions = [];
        this.currentInstructionIndex = 0;
        
        // Execution state
        this.isRunning = false;
        this.isPaused = false;
        
        // Track changes for visualization
        this.changedRegisters = new Set();
        this.changedMemory = new Set();
        
        // Track stack frames for visualization
        this.stackFrames = []; // Array of {sp: address, size: bytes, id: number, top: address}
        this.nextFrameId = 1;
    }

    loadProgram(assemblyCode) {
        const lines = assemblyCode.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('//') && !line.startsWith(';'));
        
        this.instructions = lines.map((line, index) => ({
            original: line,
            index: index,
            parsed: this.parseInstruction(line)
        }));
        
        this.currentInstructionIndex = 0;
        this.registers.pc = 0n;
    }

    parseInstruction(line) {
        // Remove comments
        line = line.split('//')[0].split(';')[0].trim();
        
        if (!line) return null;

        // Split by whitespace, but handle commas properly
        const parts = line.split(/\s+/).filter(p => p.length > 0);
        const opcode = parts[0].toLowerCase();
        
        const result = {
            opcode: opcode,
            line: line
        };

        switch (opcode) {
            case 'mov':
                // mov x0, #5
                // mov x0, x1
                if (parts.length >= 3) {
                    result.dest = this.parseRegister(parts[1]);
                    const src = parts.slice(2).join(' ');
                    if (src.startsWith('#')) {
                        result.immediate = BigInt(src.substring(1));
                    } else {
                        result.src = this.parseRegister(src);
                    }
                }
                break;

            case 'add':
            case 'sub':
                // add sp, sp, #16
                // sub sp, sp, #16
                // Also support: sub sp, sp, 16 (without #)
                if (parts.length >= 4) {
                    // Remove commas from register names
                    const destStr = parts[1].replace(/,/g, '').trim();
                    const src1Str = parts[2].replace(/,/g, '').trim();
                    result.dest = this.parseRegister(destStr);
                    result.src1 = this.parseRegister(src1Str);
                    
                    // Get the immediate value or second source
                    const src2 = parts.slice(3).join(' ').replace(/,/g, '').trim();
                    if (src2.startsWith('#')) {
                        result.immediate = BigInt(src2.substring(1));
                    } else {
                        // Try to parse as number (immediate without #)
                        const numValue = parseInt(src2);
                        if (!isNaN(numValue)) {
                            result.immediate = BigInt(numValue);
                        } else {
                            result.src2 = this.parseRegister(src2);
                        }
                    }
                }
                break;

            case 'str':
                // str x0, [sp, #8]
                if (parts.length >= 3) {
                    result.src = this.parseRegister(parts[1]);
                    const memOp = parts.slice(2).join(' ');
                    const memMatch = memOp.match(/\[([^\]]+)\]/);
                    if (memMatch) {
                        const memParts = memMatch[1].split(',');
                        result.base = this.parseRegister(memParts[0].trim());
                        if (memParts.length > 1) {
                            const offset = memParts[1].trim();
                            if (offset.startsWith('#')) {
                                result.offset = BigInt(offset.substring(1));
                            } else {
                                result.offset = BigInt(parseInt(offset));
                            }
                        } else {
                            result.offset = 0n;
                        }
                    }
                }
                break;

            case 'ldr':
                // ldr x1, [sp, #8]
                if (parts.length >= 3) {
                    result.dest = this.parseRegister(parts[1]);
                    const memOp = parts.slice(2).join(' ');
                    const memMatch = memOp.match(/\[([^\]]+)\]/);
                    if (memMatch) {
                        const memParts = memMatch[1].split(',');
                        result.base = this.parseRegister(memParts[0].trim());
                        if (memParts.length > 1) {
                            const offset = memParts[1].trim();
                            if (offset.startsWith('#')) {
                                result.offset = BigInt(offset.substring(1));
                            } else {
                                result.offset = BigInt(parseInt(offset));
                            }
                        } else {
                            result.offset = 0n;
                        }
                    }
                }
                break;

            case 'ret':
                // ret (no operands)
                break;

            case 'adr':
                // adr x0, label
                if (parts.length >= 3) {
                    result.dest = this.parseRegister(parts[1]);
                    result.label = parts.slice(2).join(' ').trim();
                }
                break;

            case 'adrp':
                // adrp x0, label
                if (parts.length >= 3) {
                    result.dest = this.parseRegister(parts[1]);
                    result.label = parts.slice(2).join(' ').trim();
                }
                break;

            default:
                console.warn(`Unknown instruction: ${opcode}`);
                return null;
        }

        return result;
    }

    parseRegister(regStr) {
        regStr = regStr.trim().toLowerCase();
        if (regStr === 'sp') return 'sp';
        if (regStr === 'lr') return 'lr';
        if (regStr === 'pc') return 'pc';
        if (regStr.startsWith('x')) {
            const num = parseInt(regStr.substring(1));
            if (num >= 0 && num <= 30) {
                return { type: 'x', num: num, name: `x${num}` };
            }
        }
        if (regStr.startsWith('w')) {
            const num = parseInt(regStr.substring(1));
            if (num >= 0 && num <= 30) {
                return { type: 'w', num: num, name: `w${num}` };
            }
        }
        return null;
    }

    executeInstruction(instruction) {
        if (!instruction || !instruction.parsed) {
            return false;
        }

        this.changedRegisters.clear();
        this.changedMemory.clear();

        const parsed = instruction.parsed;
        const opcode = parsed.opcode;
        

        try {
            switch (opcode) {
                case 'mov':
                    this.executeMov(parsed);
                    break;
                case 'add':
                    this.executeAdd(parsed);
                    break;
                case 'sub':
                    this.executeSub(parsed);
                    break;
                case 'str':
                    this.executeStr(parsed);
                    break;
                case 'ldr':
                    this.executeLdr(parsed);
                    break;
                case 'adr':
                    this.executeAdr(parsed, instruction.index);
                    break;
                case 'adrp':
                    this.executeAdrp(parsed, instruction.index);
                    break;
                case 'ret':
                    return false; // End of program
                default:
                    throw new Error(`Unsupported instruction: ${opcode}`);
            }

            // Update program counter
            this.registers.pc = BigInt(this.currentInstructionIndex + 1);
            return true;
        } catch (error) {
            // Re-throw the error so UI can display it
            throw error;
        }
    }

    getRegisterValue(reg) {
        if (typeof reg === 'string') {
            // Special registers (sp, lr, pc)
            return this.registers[reg] || 0n;
        }
        if (reg && reg.type === 'x') {
            return this.registers[reg.name] || 0n;
        }
        if (reg && reg.type === 'w') {
            // w register is lower 32 bits of x register, sign-extended
            const xValue = this.registers[`x${reg.num}`] || 0n;
            // Extract lower 32 bits and sign-extend
            const lower32 = xValue & 0xFFFFFFFFn;
            // Sign extend: if bit 31 is set, extend with 1s, else extend with 0s
            if (lower32 & 0x80000000n) {
                return lower32 | 0xFFFFFFFF00000000n;
            }
            return lower32;
        }
        return 0n;
    }

    setRegisterValue(reg, value) {
        if (typeof reg === 'string') {
            // Special registers (sp, lr, pc)
            this.registers[reg] = value;
            this.changedRegisters.add(reg);
            return;
        }
        if (reg && reg.type === 'x') {
            this.registers[reg.name] = value;
            this.changedRegisters.add(reg.name);
            // Also mark corresponding w register as changed
            this.changedRegisters.add(`w${reg.num}`);
            return;
        }
        if (reg && reg.type === 'w') {
            // Writing to w register: update lower 32 bits of x register, zero-extend upper bits
            // In ARM64, writing to w register zero-extends to x register
            const xReg = `x${reg.num}`;
            const lower32 = value & 0xFFFFFFFFn;
            this.registers[xReg] = lower32; // Upper bits are zero
            this.changedRegisters.add(xReg);
            this.changedRegisters.add(reg.name);
            return;
        }
    }

    executeMov(parsed) {
        if (!parsed.dest) return;
        
        if (parsed.immediate !== undefined) {
            this.setRegisterValue(parsed.dest, parsed.immediate);
        } else if (parsed.src) {
            const srcValue = this.getRegisterValue(parsed.src);
            this.setRegisterValue(parsed.dest, srcValue);
        }
    }

    executeAdd(parsed) {
        if (!parsed.dest || !parsed.src1) {
            throw new Error(`Invalid add instruction: missing destination or source register`);
        }
        
        const val1 = this.getRegisterValue(parsed.src1);
        let val2;
        
        if (parsed.immediate !== undefined) {
            val2 = parsed.immediate;
        } else if (parsed.src2) {
            val2 = this.getRegisterValue(parsed.src2);
        } else {
            return;
        }
        
        // Validate stack operations: if modifying sp, value must be multiple of 16 (ARM64 alignment)
        const destReg = parsed.dest;
        const isStackOp = (typeof destReg === 'string' && destReg === 'sp');
        
        if (isStackOp) {
            // Check value is multiple of 16 for alignment
            if (val2 % 16n !== 0n) {
                throw new Error(`Stack operations (sub/add sp) must use values that are multiples of 16 for alignment. Got: ${val2}`);
            }
            
            const oldSP = val1;
            const newSP = oldSP + val2;
            
            // Check new SP is 16-byte aligned
            if (newSP % 16n !== 0n) {
                throw new Error(`Stack pointer must remain 16-byte aligned. New SP would be: 0x${newSP.toString(16)}`);
            }
            
            this.setRegisterValue(parsed.dest, newSP);
            this.destroyStackFrame(Number(newSP), Number(val2));
        } else {
            const result = val1 + val2;
            this.setRegisterValue(parsed.dest, result);
        }
    }

    executeSub(parsed) {
        if (!parsed.dest || !parsed.src1) {
            throw new Error(`Invalid sub instruction: missing destination or source register. Parsed: ${JSON.stringify(parsed)}`);
        }
        
        const val1 = this.getRegisterValue(parsed.src1);
        let val2;
        
        if (parsed.immediate !== undefined) {
            val2 = parsed.immediate;
        } else if (parsed.src2) {
            val2 = this.getRegisterValue(parsed.src2);
        } else {
            throw new Error(`Invalid sub instruction: missing immediate value or second source register. Parsed: ${JSON.stringify(parsed)}`);
        }
        
        // Validate stack operations: if modifying sp, value must be multiple of 16 (ARM64 alignment)
        const destReg = parsed.dest;
        const isStackOp = (typeof destReg === 'string' && destReg === 'sp');
        
        if (isStackOp) {
            // Check value is multiple of 16 for alignment
            if (val2 % 16n !== 0n) {
                throw new Error(`Stack operations (sub/add sp) must use values that are multiples of 16 for alignment. Got: ${val2}`);
            }
            
            const oldSP = val1;
            const newSP = oldSP - val2;
            
            // Check new SP is 16-byte aligned
            if (newSP % 16n !== 0n) {
                throw new Error(`Stack pointer must remain 16-byte aligned. New SP would be: 0x${newSP.toString(16)}`);
            }
            
            // Check bounds (stack grows downward, so newSP should be less than oldSP)
            if (newSP < 0n) {
                throw new Error(`Stack overflow: SP would become negative`);
            }
            
            this.setRegisterValue(parsed.dest, newSP);
            this.createStackFrame(Number(newSP), Number(val2));
        } else {
            const result = val1 - val2;
            this.setRegisterValue(parsed.dest, result);
        }
    }

    executeStr(parsed) {
        if (!parsed.src || !parsed.base) return;
        
        const value = this.getRegisterValue(parsed.src);
        const baseAddr = this.getRegisterValue(parsed.base);
        const offset = parsed.offset || 0n;
        const address = baseAddr + offset;
        
        // Determine size: if src is w register, store 32 bits, else 64 bits
        const size = (parsed.src && parsed.src.type === 'w') ? 4 : 8;
        this.writeMemory(address, value, size);
        for (let i = 0; i < size; i++) {
            this.changedMemory.add(Number(address) + i);
        }
    }

    executeLdr(parsed) {
        if (!parsed.dest || !parsed.base) return;
        
        const baseAddr = this.getRegisterValue(parsed.base);
        const offset = parsed.offset || 0n;
        const address = baseAddr + offset;
        
        // Determine size: if dest is w register, load 32 bits, else 64 bits
        const size = (parsed.dest && parsed.dest.type === 'w') ? 4 : 8;
        const value = this.readMemory(address, size);
        this.setRegisterValue(parsed.dest, value);
        for (let i = 0; i < size; i++) {
            this.changedMemory.add(Number(address) + i);
        }
    }

    getMemoryRegion(address) {
        const addr = BigInt(address);
        for (const [key, region] of Object.entries(this.memoryLayout)) {
            if (addr >= region.start && addr <= region.end) {
                return { key, ...region };
            }
        }
        return null;
    }

    validateMemoryAccess(address, size, isWrite) {
        const addr = BigInt(address);
        
        // Check zero page access
        if (addr === 0n || (addr < 0x00100000n && addr > 0n)) {
            throw new Error(`Zero page access forbidden: 0x${addr.toString(16)}`);
        }
        
        // Check bounds
        if (addr < 0x00100000n || addr + BigInt(size - 1) > 0x07FFFFFFn) {
            throw new Error(`Memory access out of bounds: 0x${addr.toString(16)}`);
        }
        
        // Check alignment
        if (size === 8 && addr % 8n !== 0n) {
            throw new Error(`Unaligned 8-byte access at 0x${addr.toString(16)}`);
        }
        if (size === 4 && addr % 4n !== 0n) {
            throw new Error(`Unaligned 4-byte access at 0x${addr.toString(16)}`);
        }
        
        // Check region access
        const region = this.getMemoryRegion(addr);
        if (!region) {
            throw new Error(`Address 0x${addr.toString(16)} not in any memory region`);
        }
        
        // Check if all bytes are in the same region
        const endAddr = addr + BigInt(size - 1);
        if (endAddr > region.end) {
            throw new Error(`Memory access crosses region boundary: 0x${addr.toString(16)} to 0x${endAddr.toString(16)}`);
        }
        
        // Check read-only
        if (isWrite && region.readonly) {
            throw new Error(`Write to read-only region (${region.name}) at 0x${addr.toString(16)}`);
        }
        
        // Check stack/heap collision
        if (isWrite) {
            const stackRegion = this.memoryLayout.stack;
            const heapRegion = this.memoryLayout.heap;
            const currentSP = this.registers.sp;
            
            if (currentSP < stackRegion.end && currentSP >= stackRegion.start) {
                // Stack is active
                if (addr >= heapRegion.start && addr <= heapRegion.end) {
                    // Writing to heap, check if stack has grown into heap
                    if (currentSP < heapRegion.end) {
                        throw new Error(`Stack/heap collision detected: SP=0x${currentSP.toString(16)}, Heap=0x${addr.toString(16)}`);
                    }
                }
            }
            
            if (addr >= heapRegion.start && addr <= heapRegion.end) {
                // Writing to heap, check if stack has grown into heap
                if (currentSP < heapRegion.end && currentSP >= stackRegion.start) {
                    throw new Error(`Stack/heap collision detected: SP=0x${currentSP.toString(16)}, Heap=0x${addr.toString(16)}`);
                }
            }
        }
        
        return region;
    }

    writeMemory(address, value, size = 8) {
        // Validate access
        this.validateMemoryAccess(address, size, true);
        
        // Store value at address (size bytes)
        // ARM64 is little-endian
        const addr = Number(address);
        for (let i = 0; i < size; i++) {
            const byte = Number((value >> BigInt(i * 8)) & 0xFFn);
            this.memory.set(addr + i, byte);
        }
    }

    readMemory(address, size = 8) {
        // Validate access
        this.validateMemoryAccess(address, size, false);
        
        // Read value from address (size bytes)
        const addr = Number(address);
        let value = 0n;
        for (let i = 0; i < size; i++) {
            const byte = this.memory.get(addr + i) || 0;
            value |= BigInt(byte) << BigInt(i * 8);
        }
        // Sign-extend if reading 32-bit value
        if (size === 4 && (value & 0x80000000n)) {
            value |= 0xFFFFFFFF00000000n;
        }
        return value;
    }

    step() {
        if (this.currentInstructionIndex >= this.instructions.length) {
            return false;
        }

        const instruction = this.instructions[this.currentInstructionIndex];
        if (!instruction || !instruction.parsed) {
            // Skip invalid instructions
            this.currentInstructionIndex++;
            return true;
        }
        
        // executeInstruction now throws errors instead of returning false
        this.executeInstruction(instruction);
        
        // If we get here, instruction executed successfully
        this.currentInstructionIndex++;
        return true;
    }


    getCurrentInstruction() {
        if (this.currentInstructionIndex < this.instructions.length) {
            return this.instructions[this.currentInstructionIndex];
        }
        return null;
    }

    getMemoryAtAddress(address) {
        return this.readMemory(BigInt(address));
    }

    getMemorySection(address) {
        const addr = BigInt(address);
        for (const [key, section] of Object.entries(this.memoryLayout)) {
            if (addr >= section.start && addr < section.end) {
                return key;
            }
        }
        return null;
    }

    getAllMemorySections() {
        const sections = {};
        const initialSP = Number(this.memoryLayout.stack.end);
        const currentSP = Number(this.registers.sp);
        
        // Get all memory addresses that have been written to
        const allAddresses = Array.from(this.memory.keys());
        
        // Group by section
        for (const [key, section] of Object.entries(this.memoryLayout)) {
            const sectionData = [];
            const sectionStart = Number(section.start);
            const sectionEnd = Number(section.end);
            
            // For stack, show from current SP to initial SP
            if (key === 'stack') {
                const stackStart = Math.min(currentSP, sectionEnd);
                const stackEnd = sectionEnd;
                
                // Create stack frames
                const frameSize = 16;
                const frameMap = new Map();
                
                // Find addresses in stack region
                const stackAddresses = allAddresses.filter(addr => 
                    addr >= stackStart && addr < stackEnd
                );
                
                for (const addr of stackAddresses) {
                    const frameStart = Math.floor(addr / frameSize) * frameSize;
                    if (!frameMap.has(frameStart)) {
                        frameMap.set(frameStart, []);
                    }
                    frameMap.get(frameStart).push(addr);
                }
                
                // Also show current frame even if empty
                if (currentSP < initialSP) {
                    const currentFrameStart = Math.floor(currentSP / frameSize) * frameSize;
                    if (!frameMap.has(currentFrameStart)) {
                        frameMap.set(currentFrameStart, []);
                    }
                }
                
                // Create frame objects
                for (const [frameStart, addresses] of frameMap.entries()) {
                    const frameEnd = frameStart + frameSize;
                    const isActive = frameStart >= currentSP && frameStart < currentSP + frameSize;
                    
                    const frameData = [];
                    for (let addr = frameStart; addr < frameEnd; addr += 8) {
                        const value = this.readMemory(BigInt(addr));
                        const hasData = value !== 0n || addresses.some(a => a >= addr && a < addr + 8);
                        
                        if (hasData || isActive) {
                            frameData.push({
                                address: addr,
                                value: value
                            });
                        }
                    }
                    
                    if (frameData.length > 0 || isActive) {
                        sectionData.push({
                            start: frameStart,
                            end: frameEnd,
                            isActive: isActive,
                            data: frameData
                        });
                    }
                }
                
                sectionData.sort((a, b) => b.start - a.start);
            } else {
                // For other sections, show memory contents
                const sectionAddresses = allAddresses.filter(addr => 
                    addr >= sectionStart && addr < sectionEnd
                );
                
                if (sectionAddresses.length > 0) {
                    // Group into 8-byte aligned entries
                    const entryMap = new Map();
                    for (const addr of sectionAddresses) {
                        const alignedAddr = Math.floor(addr / 8) * 8;
                        if (!entryMap.has(alignedAddr)) {
                            entryMap.set(alignedAddr, []);
                        }
                        entryMap.get(alignedAddr).push(addr);
                    }
                    
                    for (const [addr, addresses] of entryMap.entries()) {
                        const value = this.readMemory(BigInt(addr));
                        sectionData.push({
                            address: addr,
                            value: value
                        });
                    }
                    
                    sectionData.sort((a, b) => a.address - b.address);
                }
            }
            
            sections[key] = {
                name: section.name,
                start: sectionStart,
                end: sectionEnd,
                data: sectionData,
                isEmpty: sectionData.length === 0 && (key !== 'stack' || currentSP >= initialSP)
            };
        }
        
        return sections;
    }

    getMemoryAtAddress(address) {
        return this.readMemory(BigInt(address));
    }

    createStackFrame(newSP, size) {
        // Create a new stack frame when SP decreases (sub sp, sp, #N)
        // newSP is the new (lower) stack pointer after subtraction
        // Frame occupies addresses [newSP, newSP + size - 1]
        const frame = {
            id: this.nextFrameId++,
            sp: newSP,
            size: size,
            top: newSP + size
        };
        this.stackFrames.push(frame);
        // Sort by SP (descending - stack grows downward, lower addresses are "below")
        this.stackFrames.sort((a, b) => b.sp - a.sp);
    }

    destroyStackFrame(newSP, size) {
        // Remove stack frame when SP increases (add sp, sp, #N)
        // newSP is the new (higher) stack pointer after addition
        // The frame we're freeing starts at (newSP - size) and ends at (newSP - 1)
        const frameToFree = newSP - size;
        
        // Find frame that matches exactly
        const frameIndex = this.stackFrames.findIndex(f => 
            f.sp === frameToFree && f.size === size
        );
        
        if (frameIndex !== -1) {
            this.stackFrames.splice(frameIndex, 1);
        } else {
            // LIFO: Remove the most recently created frame (last in array after sorting)
            // Sort first to ensure we get the topmost frame
            this.stackFrames.sort((a, b) => b.sp - a.sp);
            if (this.stackFrames.length > 0) {
                // Remove the topmost frame (lowest address, most recent)
                this.stackFrames.shift(); // Remove first (topmost after sort)
            }
        }
    }

    getStackFramesForDisplay() {
        const currentSP = Number(this.registers.sp);
        const initialSP = Number(this.memoryLayout.stack.end);
        
        // If we have frames, return them
        if (this.stackFrames.length > 0) {
            return this.stackFrames.map(frame => {
                const isActive = frame.sp <= currentSP && currentSP < frame.top;
                return {
                    ...frame,
                    isActive: isActive,
                    data: this.getFrameData(frame.sp, frame.size)
                };
            }).sort((a, b) => b.sp - a.sp);
        }
        
        // If SP has moved but no frames tracked, create a visual frame
        if (currentSP < initialSP) {
            const stackSize = initialSP - currentSP;
            return [{
                id: 0,
                sp: currentSP,
                size: stackSize,
                top: initialSP,
                isActive: true,
                data: this.getFrameData(currentSP, stackSize)
            }];
        }
        
        return [];
    }

    getFrameData(startAddr, size) {
        const data = [];
        for (let addr = startAddr; addr < startAddr + size; addr += 8) {
            try {
                const value = this.readMemory(BigInt(addr));
                const hasData = value !== 0n || Array.from(this.memory.keys()).some(m => 
                    m >= addr && m < addr + 8
                );
                if (hasData) {
                    data.push({
                        address: addr,
                        value: value
                    });
                }
            } catch (e) {
                // Skip invalid addresses
            }
        }
        return data;
    }

    executeAdr(parsed, instructionIndex) {
        if (!parsed.dest || !parsed.label) {
            throw new Error(`Invalid adr instruction: missing destination or label`);
        }
        
        // Get label address (for now, use a placeholder - will implement label resolution)
        // For now, treat label as an immediate offset
        let labelAddr;
        if (this.labels.has(parsed.label)) {
            labelAddr = this.labels.get(parsed.label);
        } else {
            // Try to parse as immediate offset
            const imm = parseInt(parsed.label);
            if (!isNaN(imm)) {
                // ADR: Xd = PC + signed_21_bit_immediate
                const pc = BigInt(instructionIndex * 4); // Assume 4-byte instructions
                labelAddr = pc + BigInt(imm);
            } else {
                throw new Error(`Label '${parsed.label}' not found`);
            }
        }
        
        // ADR formula: Xd = PC + signed_21_bit_immediate
        const pc = BigInt(instructionIndex * 4);
        const result = labelAddr; // For now, use label address directly
        
        // Check bounds
        if (result < 0x00100000n || result > 0x07FFFFFFn) {
            throw new Error(`ADR result out of memory bounds: 0x${result.toString(16)}`);
        }
        
        this.setRegisterValue(parsed.dest, result);
    }

    executeAdrp(parsed, instructionIndex) {
        if (!parsed.dest || !parsed.label) {
            throw new Error(`Invalid adrp instruction: missing destination or label`);
        }
        
        // Get label address
        let labelAddr;
        if (this.labels.has(parsed.label)) {
            labelAddr = this.labels.get(parsed.label);
        } else {
            // Try to parse as immediate offset
            const imm = parseInt(parsed.label);
            if (!isNaN(imm)) {
                // ADRP: Xd = (PC & ~0xFFF) + (imm << 12)
                const pc = BigInt(instructionIndex * 4);
                const pageBase = pc & ~0xFFFn;
                labelAddr = pageBase + (BigInt(imm) << 12n);
            } else {
                throw new Error(`Label '${parsed.label}' not found`);
            }
        }
        
        // ADRP formula: Xd = (PC & ~0xFFF) + (imm << 12)
        const pc = BigInt(instructionIndex * 4);
        const pageBase = pc & ~0xFFFn;
        
        // Calculate page offset from label
        const labelPageBase = labelAddr & ~0xFFFn;
        const pageOffset = labelPageBase - (pc & ~0xFFFn);
        const result = pageBase + pageOffset;
        
        // Check bounds
        if (result < 0x00100000n || result > 0x07FFFFFFn) {
            throw new Error(`ADRP result out of memory bounds: 0x${result.toString(16)}`);
        }
        
        this.setRegisterValue(parsed.dest, result);
    }

    allocateHeap(size) {
        // Bump pointer allocator
        const oldPtr = this.heapPtr;
        const newPtr = oldPtr + BigInt(size);
        
        // Check heap overflow
        if (newPtr > this.memoryLayout.heap.end) {
            throw new Error(`Heap overflow: allocation of ${size} bytes would exceed heap limit`);
        }
        
        // Check stack/heap collision
        const currentSP = this.registers.sp;
        if (currentSP < this.memoryLayout.stack.end && currentSP >= this.memoryLayout.stack.start) {
            if (newPtr >= currentSP) {
                throw new Error(`Heap/stack collision: heap at 0x${newPtr.toString(16)}, stack at 0x${currentSP.toString(16)}`);
            }
        }
        
        this.heapPtr = newPtr;
        return oldPtr;
    }

    getAllMemoryRegions() {
        const regions = {};
        const allAddresses = Array.from(this.memory.keys());
        
        for (const [key, region] of Object.entries(this.memoryLayout)) {
            const regionData = [];
            const regionStart = Number(region.start);
            const regionEnd = Number(region.end);
            
            // Get all addresses in this region
            const regionAddresses = allAddresses.filter(addr => 
                addr >= regionStart && addr <= regionEnd
            );
            
            if (regionAddresses.length > 0) {
                // Group into 8-byte aligned entries
                const entryMap = new Map();
                for (const addr of regionAddresses) {
                    const alignedAddr = Math.floor(addr / 8) * 8;
                    if (!entryMap.has(alignedAddr)) {
                        entryMap.set(alignedAddr, alignedAddr);
                    }
                }
                
                for (const addr of entryMap.keys()) {
                    try {
                        const value = this.readMemory(BigInt(addr));
                        regionData.push({
                            address: addr,
                            value: value
                        });
                    } catch (e) {
                        // Skip invalid
                    }
                }
                
                regionData.sort((a, b) => a.address - b.address);
            }
            
            regions[key] = {
                name: region.name,
                start: regionStart,
                end: regionEnd,
                readonly: region.readonly,
                data: regionData,
                isEmpty: regionData.length === 0
            };
        }
        
        return regions;
    }
}


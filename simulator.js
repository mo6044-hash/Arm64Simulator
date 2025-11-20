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
        
        // Initialize region used size tracking
        this.regionUsedSize = {
            rodata: 0n,
            data: 0n,
            bss: 0n,
            heap: 0n,
            stack: 0n
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
            pc: 0n
        };

        // Memory: byte-addressable, stores 64-bit values
        this.memory = new Map();
        
        // Heap allocator (bump pointer)
        this.heapPtr = 0x00400000n;
        
        // Symbol table: label name -> {address, section, type}
        this.symbolTable = new Map();
        
        // Section location counters
        this.sectionCounters = {
            rodata: this.memoryLayout.rodata.start,
            data: this.memoryLayout.data.start,
            bss: this.memoryLayout.bss.start,
            text: 0x00000000n  // Code starts at 0x00000000
        };
        
        // Current section being processed
        this.currentSection = 'text';
        
        // NZCV flags (Negative, Zero, Carry, oVerflow)
        this.flags = {
            N: false,  // Negative
            Z: false,  // Zero
            C: false,  // Carry
            V: false   // oVerflow
        };
        
        // Program instructions with addresses
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
        
        // Track entry point (_start/main) to detect when RET should end program
        this.entryPointAddress = 0n;
        this.entryPointLabel = null; // Store the label name (_start or main)
        this.entryFunctionEndIndex = -1; // Last instruction index of entry function
    }

    loadProgram(assemblyCode) {
        // Initialize parser
        if (!this.parser) {
            this.parser = new ARM64Parser(this);
        }
        
        // Split into lines and filter empty/comments
        const lines = assemblyCode.split('\n')
            .map(line => line.trim())
            .filter(line => {
                const trimmed = line.trim();
                return trimmed.length > 0 && 
                       !trimmed.startsWith('//') && 
                       !trimmed.startsWith(';') &&
                       trimmed !== '';
            });
        
        // First pass: build symbol table
        const { symbolTable, sectionCounters } = this.parser.buildSymbolTable(lines);
        this.symbolTable = symbolTable;
        this.sectionCounters = sectionCounters;
        
        // Second pass: parse instructions and directives
        const { instructions, dataInitializations } = this.parser.parseProgram(lines, symbolTable);
        this.instructions = instructions;
        
        // Initialize memory regions with data BEFORE execution
        this.initializeMemoryRegions(dataInitializations);
        
        // Find entry point: check for .global _start or .global main, then _start, then main, then first instruction
        let entryPoint = 0x00000000n;
        let entryLabel = null;
        
        // First, check for .global _start or .global main (priority order: _start, then main)
        for (const [labelName, labelInfo] of symbolTable.entries()) {
            if (labelInfo.isGlobal) {
                if (labelName === '_start') {
                    entryPoint = labelInfo.address;
                    entryLabel = '_start';
                    break; // _start has highest priority
                } else if (labelName === 'main' && !entryLabel) {
                    entryPoint = labelInfo.address;
                    entryLabel = 'main';
                }
            }
        }
        
        // If no .global found, check for _start or main labels (non-global)
        if (!entryLabel) {
            if (symbolTable.has('_start')) {
                entryPoint = symbolTable.get('_start').address;
                entryLabel = '_start';
            } else if (symbolTable.has('main')) {
                entryPoint = symbolTable.get('main').address;
                entryLabel = 'main';
            } else if (instructions.length > 0) {
                // Fall back to first instruction
                entryPoint = instructions[0].address;
            }
        }
        
        // Find the instruction at the entry point address
        // The label address points to where the first instruction after the label is placed
        // We need to find the FIRST instruction at or after the entry point address
        let foundIndex = -1;
        for (let i = 0; i < instructions.length; i++) {
            if (instructions[i].address >= entryPoint) {
                foundIndex = i;
                entryPoint = instructions[i].address; // Use actual instruction address
                break;
            }
        }
        
        // If no instruction found at or after entry point, use first instruction
        if (foundIndex === -1 && instructions.length > 0) {
            foundIndex = 0;
            entryPoint = instructions[0].address;
        }
        
        // Ensure we have a valid instruction index
        if (foundIndex >= 0 && foundIndex < instructions.length) {
            this.currentInstructionIndex = foundIndex;
        } else if (instructions.length > 0) {
            this.currentInstructionIndex = 0;
            entryPoint = instructions[0].address;
        } else {
            this.currentInstructionIndex = 0;
        }
        
        // Set PC to the entry point (address of first instruction to execute)
        // PC must point to the instruction that will be executed when step() is first called
        // This is the instruction at currentInstructionIndex
        this.registers.pc = entryPoint;
        
        // Store entry point address and label to detect when RET is called from _start/main
        this.entryPointAddress = entryPoint;
        this.entryPointLabel = entryLabel;
        
        // Find the end of the entry function by looking for the next function label
        // A function label is one that's in the .text section and has an address after the entry point
        let entryFunctionEndIndex = instructions.length; // Default: end of program
        if (entryLabel) {
            const entryPointIndex = this.findInstructionIndexByAddress(entryPoint);
            
            // Look for the next function label (text section label) after the entry point
            for (const [labelName, labelInfo] of symbolTable.entries()) {
                // Skip the entry label itself
                if (labelName === entryLabel) continue;
                
                // Check if this is a function label (in text section)
                if (labelInfo.section === 'text' && labelInfo.address > entryPoint) {
                    // Found the next function - find its instruction index
                    const nextFunctionIndex = this.findInstructionIndexByAddress(labelInfo.address);
                    if (nextFunctionIndex > entryPointIndex) {
                        entryFunctionEndIndex = nextFunctionIndex;
                        break; // Use the first function we find after entry point
                    }
                }
            }
        }
        this.entryFunctionEndIndex = entryFunctionEndIndex;
        
        // Force UI update to show initialized memory
        if (window.simulatorUI) {
            window.simulatorUI.updateDisplay();
        }
    }

    findInstructionIndexByAddress(address) {
        // Find the instruction at the exact address, or the first instruction at or after that address
        const addr = BigInt(address);
        for (let i = 0; i < this.instructions.length; i++) {
            if (this.instructions[i].address === addr) {
                return i;
            }
            // If we've passed the address, return the previous instruction (shouldn't happen if address is exact)
            if (this.instructions[i].address > addr) {
                return i > 0 ? i - 1 : 0;
            }
        }
        // If no instruction found, return 0 (first instruction)
        return 0;
    }

    initializeMemoryRegions(dataInitializations) {
        // Track used size for each region
        this.regionUsedSize = {
            rodata: 0n,
            data: 0n,
            bss: 0n,
            heap: 0n,
            stack: 0n
        };
        
        // Initialize BSS to zero (already done by reset, but ensure it's clear)
        // Data initializations will write the actual values
        // During initialization, we need to write to Rodata, so skip readonly check
        for (const init of dataInitializations) {
            this.writeMemory(init.address, init.value, init.size, true); // true = skip readonly check during init
            
            // Track used size for this region
            const regionKey = init.section;
            if (this.regionUsedSize.hasOwnProperty(regionKey)) {
                const endAddr = init.address + BigInt(init.size);
                const regionStart = this.memoryLayout[regionKey].start;
                const usedSize = endAddr - regionStart;
                if (usedSize > this.regionUsedSize[regionKey]) {
                    this.regionUsedSize[regionKey] = usedSize;
                }
            }
        }
    }

    parseInstruction(line) {
        // Remove comments
        line = line.split('//')[0].split(';')[0].trim();
        
        if (!line) return null;

        // Split by whitespace, but handle commas properly
        const parts = line.split(/\s+/).filter(p => p.length > 0);
        let opcode = parts[0].toLowerCase();
        
        // Check for conditional branches (beq, bne, ble, etc.) - NO DOTS
        // These are separate opcodes, not "b" with a condition
        if (opcode.match(/^b(eq|ne|lt|le|gt|ge|lo|ls|hi|hs|mi|pl)$/)) {
            // This is a conditional branch - keep as is
        }
        
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
            case 'subs':
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

            case 'cmp':
                // cmp x0, x1 or cmp x0, #5
                if (parts.length >= 3) {
                    const src1Str = parts[1].replace(/,/g, '').trim();
                    result.src1 = this.parseRegister(src1Str);
                    
                    const src2 = parts.slice(2).join(' ').replace(/,/g, '').trim();
                    if (src2.startsWith('#')) {
                        // Immediate: cmp xN, #imm
                        result.immediate = BigInt(src2.substring(1));
                    } else {
                        // Register: cmp xN, xM
                        result.src2 = this.parseRegister(src2);
                    }
                } else {
                    throw new Error(`Invalid cmp instruction: missing operands`);
                }
                break;

            case 'and':
            case 'ands':
            case 'orr':
            case 'eor':
            case 'bic':
                // Logical operations: and x0, x1, x2
                // and x0, x1, #0xFF
                // and x0, x1, x2, lsl #3
                if (parts.length >= 4) {
                    const destStr = parts[1].replace(/,/g, '').trim();
                    const src1Str = parts[2].replace(/,/g, '').trim();
                    result.dest = this.parseRegister(destStr);
                    result.src1 = this.parseRegister(src1Str);
                    
                    // Get the second operand (immediate, register, or shifted register)
                    const src2Part = parts.slice(3).join(' ').replace(/,/g, '').trim();
                    
                    // Check for shifted register: "x2, lsl #3" or "x2, lsr #2" or "x2, asr #1"
                    const shiftedMatch = src2Part.match(/^(\w+)\s*,\s*(lsl|lsr|asr)\s*#(\d+)$/i);
                    if (shiftedMatch) {
                        result.src2 = this.parseRegister(shiftedMatch[1]);
                        result.shiftType = shiftedMatch[2].toLowerCase();
                        result.shiftAmount = parseInt(shiftedMatch[3]);
                    } else if (src2Part.startsWith('#')) {
                        // Immediate: and x0, x1, #0xFF
                        result.immediate = BigInt(src2Part.substring(1));
                    } else {
                        // Register: and x0, x1, x2
                        result.src2 = this.parseRegister(src2Part);
                    }
                }
                break;

            case 'b':
                // b label (unconditional)
                if (parts.length >= 2) {
                    result.label = parts.slice(1).join(' ').trim();
                }
                break;

            case 'bl':
                // bl label
                if (parts.length >= 2) {
                    result.label = parts.slice(1).join(' ').trim();
                }
                break;

            case 'cbz':
            case 'cbnz':
                // cbz x0, label
                if (parts.length >= 3) {
                    result.src = this.parseRegister(parts[1].replace(/,/g, '').trim());
                    result.label = parts.slice(2).join(' ').trim();
                }
                break;

            case 'str':
                // str x0, [sp, #8]
                // str x0, [x1, x2] - register offset
                // str x0, [x1, x2, lsl #3] - scaled offset
                if (parts.length >= 3) {
                    result.src = this.parseRegister(parts[1]);
                    const memOp = parts.slice(2).join(' ');
                    const memMatch = memOp.match(/\[([^\]]+)\]/);
                    if (memMatch) {
                        const memParts = memMatch[1].split(',');
                        result.base = this.parseRegister(memParts[0].trim());
                        
                        if (memParts.length > 1) {
                            const offsetPart = memParts[1].trim();
                            
                            // Check for scaled offset: x2, lsl #3
                            const scaledMatch = offsetPart.match(/(\w+)\s*,\s*lsl\s*#(\d+)/i);
                            if (scaledMatch) {
                                result.offsetReg = this.parseRegister(scaledMatch[1]);
                                result.shift = parseInt(scaledMatch[2]);
                                result.offsetType = 'scaled';
                            } else if (offsetPart.startsWith('#')) {
                                // Immediate offset
                                result.offset = BigInt(offsetPart.substring(1));
                                result.offsetType = 'immediate';
                            } else {
                                // Try register offset
                                const regOffset = this.parseRegister(offsetPart);
                                if (regOffset) {
                                    result.offsetReg = regOffset;
                                    result.offsetType = 'register';
                                } else {
                                    // Try as immediate without #
                                    const numValue = parseInt(offsetPart);
                                    if (!isNaN(numValue)) {
                                        result.offset = BigInt(numValue);
                                        result.offsetType = 'immediate';
                                    }
                                }
                            }
                        } else {
                            result.offset = 0n;
                            result.offsetType = 'immediate';
                        }
                    }
                }
                break;

            case 'ldr':
                // ldr x1, [sp, #8]
                // ldr x1, [x0, x2] - register offset
                // ldr x1, [x0, x2, lsl #3] - scaled offset
                if (parts.length >= 3) {
                    result.dest = this.parseRegister(parts[1]);
                    const memOp = parts.slice(2).join(' ');
                    const memMatch = memOp.match(/\[([^\]]+)\]/);
                    if (memMatch) {
                        const memParts = memMatch[1].split(',');
                        result.base = this.parseRegister(memParts[0].trim());
                        
                        if (memParts.length > 1) {
                            const offsetPart = memParts[1].trim();
                            
                            // Check for scaled offset: x2, lsl #3
                            const scaledMatch = offsetPart.match(/(\w+)\s*,\s*lsl\s*#(\d+)/i);
                            if (scaledMatch) {
                                result.offsetReg = this.parseRegister(scaledMatch[1]);
                                result.shift = parseInt(scaledMatch[2]);
                                result.offsetType = 'scaled';
                            } else if (offsetPart.startsWith('#')) {
                                // Immediate offset
                                result.offset = BigInt(offsetPart.substring(1));
                                result.offsetType = 'immediate';
                            } else {
                                // Try register offset
                                const regOffset = this.parseRegister(offsetPart);
                                if (regOffset) {
                                    result.offsetReg = regOffset;
                                    result.offsetType = 'register';
                                } else {
                                    // Try as immediate without #
                                    const numValue = parseInt(offsetPart);
                                    if (!isNaN(numValue)) {
                                        result.offset = BigInt(numValue);
                                        result.offsetType = 'immediate';
                                    }
                                }
                            }
                        } else {
                            result.offset = 0n;
                            result.offsetType = 'immediate';
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
                // Check for conditional branches (beq, bne, ble, etc.) - NO DOTS
                if (opcode.match(/^b(eq|ne|lt|le|gt|ge|lo|ls|hi|hs|mi|pl)$/)) {
                    // Parse like unconditional branch: beq label
                    if (parts.length >= 2) {
                        result.label = parts.slice(1).join(' ').trim();
                    }
                } else {
                    console.warn(`Unknown instruction: ${opcode}`);
                    return null;
                }
                break;
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
        
        // Get instruction address for PC-relative operations
        // PC should already be set to this address by step(), but use instruction.address as source of truth
        const instructionAddress = instruction.address || this.registers.pc;

        try {
            let pcModified = false;
            
            switch (opcode) {
                case 'mov':
                    this.executeMov(parsed);
                    break;
                case 'add':
                    this.executeAdd(parsed);
                    break;
                case 'sub':
                case 'subs':
                    this.executeSub(parsed, opcode === 'subs');
                    break;
                case 'str':
                    this.executeStr(parsed);
                    break;
                case 'ldr':
                    this.executeLdr(parsed);
                    break;
                case 'adr':
                    this.executeAdr(parsed, instructionAddress);
                    break;
                case 'adrp':
                    this.executeAdrp(parsed, instructionAddress);
                    break;
                case 'cmp':
                    this.executeCmp(parsed);
                    break;
                case 'and':
                case 'ands':
                case 'orr':
                case 'eor':
                case 'bic':
                    this.executeLogical(parsed, opcode);
                    break;
                case 'b':
                    pcModified = this.executeB(parsed);
                    break;
                case 'bl':
                    pcModified = this.executeBl(parsed);
                    break;
                case 'ret':
                    pcModified = this.executeRet(parsed);
                    if (!pcModified) {
                        // Program ended (returning from _start/main)
                        return false; // End of program
                    }
                    break;
                case 'cbz':
                case 'cbnz':
                    pcModified = this.executeCbz(parsed, opcode);
                    break;
                default:
                    // Check for conditional branches (beq, bne, ble, bge, etc.) - NO DOTS
                    if (opcode.match(/^b(eq|ne|lt|le|gt|ge|lo|ls|hi|hs|mi|pl)$/)) {
                        pcModified = this.executeConditionalBranch(parsed, opcode);
                    } else {
                        throw new Error(`Unsupported instruction: ${opcode}`);
                    }
            }
            
            // Update PC (unless instruction modified it)
            // After executing instruction at address N, PC should point to next instruction at N+4
            if (!pcModified) {
                // PC should now point to the next instruction (current + 4 bytes)
                this.registers.pc = instructionAddress + 4n;
                this.currentInstructionIndex = this.findInstructionIndexByAddress(this.registers.pc);
            }
            
            return true;
        } catch (error) {
            throw error;
        }
    }

    getRegisterValue(reg) {
        if (typeof reg === 'string') {
            // Special registers (sp, pc)
            // Note: LR is x30, not a separate register
            if (reg === 'lr') {
                return this.registers.x30 || 0n;
            }
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
            // Special registers (sp, pc)
            // Note: LR is x30, not a separate register
            if (reg === 'lr') {
                this.registers.x30 = value;
                this.changedRegisters.add('x30');
                this.changedRegisters.add('w30');
                return;
            }
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

    executeSub(parsed, setFlags = false) {
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
            
            // Update flags if subs
            if (setFlags) {
                const size = (parsed.dest && parsed.dest.type === 'w') ? 32 : 64;
                this.updateFlags(result, size);
            }
        }
    }

    executeLogical(parsed, opcode) {
        // Logical operations: AND, ANDS, ORR, EOR, BIC
        // and x0, x1, x2
        // and x0, x1, #0xFF
        // and x0, x1, x2, lsl #3
        if (!parsed.dest || !parsed.src1) {
            throw new Error(`Invalid ${opcode} instruction: missing destination or source register`);
        }
        
        const val1 = this.getRegisterValue(parsed.src1);
        let val2;
        
        // Get second operand (immediate, register, or shifted register)
        if (parsed.immediate !== undefined) {
            val2 = parsed.immediate;
        } else if (parsed.src2) {
            val2 = this.getRegisterValue(parsed.src2);
            
            // Apply shift if specified
            if (parsed.shiftType && parsed.shiftAmount !== undefined) {
                const shiftAmount = BigInt(parsed.shiftAmount);
                switch (parsed.shiftType) {
                    case 'lsl':
                        // Logical shift left
                        val2 = val2 << shiftAmount;
                        break;
                    case 'lsr':
                        // Logical shift right
                        val2 = val2 >> shiftAmount;
                        break;
                    case 'asr':
                        // Arithmetic shift right (sign-extending)
                        // For BigInt, right shift is arithmetic (sign-extending) by default
                        // But we need to ensure proper sign extension for the register size
                        const srcSize = (parsed.src2 && parsed.src2.type === 'w') ? 32 : 64;
                        const srcMask = srcSize === 64 ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
                        const srcSignBit = srcSize === 64 ? 63 : 31;
                        
                        // Sign-extend the value to the proper size first
                        let signedVal = val2 & srcMask;
                        if ((signedVal & (1n << BigInt(srcSignBit))) !== 0n) {
                            // Negative: sign-extend upper bits
                            signedVal = signedVal | (~srcMask);
                        }
                        
                        // Perform arithmetic shift right (BigInt >> is arithmetic for signed values)
                        val2 = signedVal >> shiftAmount;
                        
                        // Mask to size
                        val2 = val2 & srcMask;
                        break;
                }
            }
        } else {
            throw new Error(`Invalid ${opcode} instruction: missing second operand`);
        }
        
        // Determine result size based on destination register
        const size = (parsed.dest && parsed.dest.type === 'w') ? 32 : 64;
        const mask = size === 64 ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
        
        // Perform the logical operation
        let result;
        switch (opcode) {
            case 'and':
            case 'ands':
                result = (val1 & val2) & mask;
                break;
            case 'orr':
                result = (val1 | val2) & mask;
                break;
            case 'eor':
                result = (val1 ^ val2) & mask;
                break;
            case 'bic':
                // BIC: Rd = Rn & (~Rm)
                result = (val1 & (~val2)) & mask;
                break;
            default:
                throw new Error(`Unknown logical operation: ${opcode}`);
        }
        
        // Write result to destination register
        this.setRegisterValue(parsed.dest, result);
        
        // Update flags for ANDS only
        if (opcode === 'ands') {
            const signBit = size === 64 ? 63 : 31;
            this.flags.N = (result & (1n << BigInt(signBit))) !== 0n; // Negative flag
            this.flags.Z = (result & mask) === 0n; // Zero flag
            // C and V flags are unaffected by logical operations
        }
    }

    executeStr(parsed) {
        if (!parsed.src || !parsed.base) return;
        
        const value = this.getRegisterValue(parsed.src);
        const baseAddr = this.getRegisterValue(parsed.base);
        
        // Calculate effective address based on offset type
        let offset = 0n;
        if (parsed.offsetType === 'scaled') {
            const regValue = this.getRegisterValue(parsed.offsetReg);
            offset = regValue << BigInt(parsed.shift || 0);
        } else if (parsed.offsetType === 'register') {
            offset = this.getRegisterValue(parsed.offsetReg);
        } else {
            offset = parsed.offset || 0n;
        }
        
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
        
        // Calculate effective address based on offset type
        let offset = 0n;
        if (parsed.offsetType === 'scaled') {
            const regValue = this.getRegisterValue(parsed.offsetReg);
            offset = regValue << BigInt(parsed.shift || 0);
        } else if (parsed.offsetType === 'register') {
            offset = this.getRegisterValue(parsed.offsetReg);
        } else {
            offset = parsed.offset || 0n;
        }
        
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
        
        // Check alignment (ARM64 supports unaligned accesses, but warn for performance)
        // Allow unaligned accesses but they may be slower in real hardware
        // We'll allow them in the simulator for flexibility
        if (size === 8 && addr % 8n !== 0n) {
            // ARM64 supports unaligned 8-byte accesses, but warn
            console.warn(`Unaligned 8-byte access at 0x${addr.toString(16)} (allowed but may be slower)`);
        }
        if (size === 4 && addr % 4n !== 0n) {
            // ARM64 supports unaligned 4-byte accesses
            console.warn(`Unaligned 4-byte access at 0x${addr.toString(16)} (allowed but may be slower)`);
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

    writeMemory(address, value, size = 8, skipReadonlyCheck = false) {
        // Validate access (but allow skipping readonly check during initialization)
        if (!skipReadonlyCheck) {
            this.validateMemoryAccess(address, size, true);
        } else {
            // Still validate bounds and other checks, but skip readonly
            const addr = BigInt(address);
            
            // Check zero page access
            if (addr === 0n || (addr < 0x00100000n && addr > 0n)) {
                throw new Error(`Zero page access forbidden: 0x${addr.toString(16)}`);
            }
            
            // Check bounds
            if (addr < 0x00100000n || addr + BigInt(size - 1) > 0x07FFFFFFn) {
                throw new Error(`Memory access out of bounds: 0x${addr.toString(16)}`);
            }
            
            // Find region (but don't check readonly)
            const region = this.getMemoryRegion(address);
            if (!region) {
                throw new Error(`Memory access to unmapped region: 0x${addr.toString(16)}`);
            }
            
            // Check region bounds
            const endAddr = addr + BigInt(size - 1);
            if (endAddr > region.end) {
                throw new Error(`Memory access crosses region boundary: 0x${addr.toString(16)} to 0x${endAddr.toString(16)}`);
            }
        }
        
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
            // Update PC to next instruction
            if (this.currentInstructionIndex < this.instructions.length) {
                const nextInstruction = this.instructions[this.currentInstructionIndex];
                this.registers.pc = nextInstruction.address || BigInt(this.currentInstructionIndex * 4);
            }
            return true;
        }
        
        // CRITICAL: Set PC to the address of the CURRENT instruction BEFORE execution
        // PC must hold the address of the instruction being executed, not the next one
        // This is required for ARM64: PC points to the instruction currently being executed
        const instructionAddress = instruction.address || BigInt(this.currentInstructionIndex * 4);
        this.registers.pc = instructionAddress;
        
        // executeInstruction will:
        // 1. Use instructionAddress for PC-relative operations (ADR, ADRP)
        // 2. Update PC after execution (either +4 for next instruction, or branch target)
        // 3. Update currentInstructionIndex based on the new PC
        // 4. Return false if program should end (e.g., ret from _start/main)
        const shouldContinue = this.executeInstruction(instruction);
        if (!shouldContinue) {
            // Program ended
            return false;
        }
        
        // Check if we've reached the end of instructions
        if (this.currentInstructionIndex >= this.instructions.length) {
            return false; // End of program
        }
        
        // Check if PC is 0 (invalid/end state)
        if (this.registers.pc === 0n) {
            return false; // End of program
        }
        
        // currentInstructionIndex is already updated by executeInstruction
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

    executeAdr(parsed, instructionAddress) {
        if (!parsed.dest || !parsed.label) {
            throw new Error(`Invalid adr instruction: missing destination or label`);
        }
        
        // Look up label in symbol table
        if (!this.symbolTable.has(parsed.label)) {
            throw new Error(`Label '${parsed.label}' not found`);
        }
        
        const labelInfo = this.symbolTable.get(parsed.label);
        const labelAddr = labelInfo.address;
        
        // ADR returns the exact absolute address of the label
        // Check bounds
        if (labelAddr < 0x00100000n && labelAddr > 0n) {
            throw new Error(`ADR result in zero page: 0x${labelAddr.toString(16)}`);
        }
        
        this.setRegisterValue(parsed.dest, labelAddr);
    }

    executeAdrp(parsed, instructionAddress) {
        if (!parsed.dest || !parsed.label) {
            throw new Error(`Invalid adrp instruction: missing destination or label`);
        }
        
        // Look up label in symbol table
        if (!this.symbolTable.has(parsed.label)) {
            throw new Error(`Label '${parsed.label}' not found`);
        }
        
        const labelInfo = this.symbolTable.get(parsed.label);
        const labelAddr = labelInfo.address;
        
        // ADRP returns the page-aligned address (upper 52 bits, lower 12 bits cleared)
        const result = labelAddr & ~0xFFFn;
        
        // Check bounds
        if (result < 0x00100000n && result > 0n) {
            throw new Error(`ADRP result in zero page: 0x${result.toString(16)}`);
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

    // NZCV flag operations
    updateFlags(result, size = 64) {
        const mask = size === 64 ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
        const signBit = size === 64 ? 63 : 31;
        
        this.flags.N = (result & (1n << BigInt(signBit))) !== 0n;
        this.flags.Z = (result & mask) === 0n;
        // C and V flags need more context (carry/overflow from operation)
    }

    // CMP instruction: compare two values and set flags
    executeCmp(parsed) {
        if (!parsed.src1) {
            throw new Error(`Invalid cmp instruction: missing first operand`);
        }
        
        const val1 = this.getRegisterValue(parsed.src1);
        let val2;
        
        // Check for immediate first (cmp xN, #imm)
        if (parsed.immediate !== undefined) {
            val2 = parsed.immediate;
        } else if (parsed.src2) {
            // Register comparison (cmp xN, xM)
            val2 = this.getRegisterValue(parsed.src2);
        } else {
            throw new Error(`Invalid cmp instruction: missing second operand (register or immediate)`);
        }
        
        const result = val1 - val2;
        const size = (parsed.src1 && parsed.src1.type === 'w') ? 32 : 64;
        
        // Set N and Z flags
        const mask = size === 64 ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
        const signBit = size === 64 ? 63 : 31;
        
        this.flags.N = (result & (1n << BigInt(signBit))) !== 0n;
        this.flags.Z = (result & mask) === 0n;
        
        // C flag: no borrow (val1 >= val2 in unsigned sense)
        this.flags.C = val1 >= val2;
        
        // V flag: signed overflow in subtraction
        // Overflow occurs when subtracting two numbers with different signs produces a result
        // that has a different sign than expected
        // Specifically: V = (val1 is negative != val2 is negative) && (result is negative != val1 is negative)
        const signMask = 1n << BigInt(signBit);
        
        const val1Negative = (val1 & signMask) !== 0n;
        const val2Negative = (val2 & signMask) !== 0n;
        const resultNegative = (result & signMask) !== 0n;
        
        // Overflow occurs when:
        // - We're subtracting numbers with different signs (val1 negative != val2 negative)
        // - AND the result has a different sign than val1 (result negative != val1 negative)
        // This means: (val1Negative != val2Negative) && (resultNegative != val1Negative)
        this.flags.V = (val1Negative !== val2Negative) && (resultNegative !== val1Negative);
    }

    toSigned(value, size) {
        const mask = size === 64 ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
        const signBit = size === 64 ? 63 : 31;
        if ((value & (1n << BigInt(signBit))) !== 0n) {
            // Negative
            return value - (1n << BigInt(size));
        }
        return value;
    }

    // Branch instructions
    executeB(parsed) {
        if (!parsed.label) {
            throw new Error(`Invalid b instruction: missing label`);
        }
        
        if (!this.symbolTable.has(parsed.label)) {
            throw new Error(`Label '${parsed.label}' not found`);
        }
        
        const labelInfo = this.symbolTable.get(parsed.label);
        this.registers.pc = labelInfo.address;
        this.currentInstructionIndex = this.findInstructionIndexByAddress(this.registers.pc);
        return true; // PC modified
    }

    executeConditionalBranch(parsed, opcode) {
        if (!parsed.label) {
            throw new Error(`Invalid ${opcode} instruction: missing label`);
        }
        
        // Extract condition (e.g., "eq", "ne", "lt", "ge") - opcode is "beq", "bne", etc. (no dot)
        const condition = opcode.substring(1); // Remove "b" from "beq" -> "eq"
        
        // Evaluate condition based on NZCV flags
        let conditionMet = false;
        
        switch (condition) {
            case 'eq': conditionMet = this.flags.Z; break;
            case 'ne': conditionMet = !this.flags.Z; break;
            case 'lt': conditionMet = this.flags.N !== this.flags.V; break;
            case 'le': conditionMet = this.flags.Z || (this.flags.N !== this.flags.V); break;
            case 'gt': conditionMet = !this.flags.Z && (this.flags.N === this.flags.V); break;
            case 'ge': conditionMet = this.flags.N === this.flags.V; break;
            case 'lo': conditionMet = !this.flags.C; break; // Unsigned <
            case 'ls': conditionMet = !this.flags.C || this.flags.Z; break; // Unsigned <=
            case 'hi': conditionMet = this.flags.C && !this.flags.Z; break; // Unsigned >
            case 'hs': conditionMet = this.flags.C; break; // Unsigned >=
            case 'mi': conditionMet = this.flags.N; break; // Negative
            case 'pl': conditionMet = !this.flags.N; break; // Positive or zero
            default:
                throw new Error(`Unknown branch condition: ${condition}`);
        }
        
        if (conditionMet) {
            // Branch taken
            if (!this.symbolTable.has(parsed.label)) {
                throw new Error(`Label '${parsed.label}' not found`);
            }
            const labelInfo = this.symbolTable.get(parsed.label);
            this.registers.pc = labelInfo.address;
            this.currentInstructionIndex = this.findInstructionIndexByAddress(this.registers.pc);
            return true; // PC modified
        } else {
            // Branch not taken, fall through
            return false; // PC will be incremented normally
        }
    }

    executeCbz(parsed, opcode) {
        if (!parsed.src || !parsed.label) {
            throw new Error(`Invalid ${opcode} instruction: missing operands`);
        }
        
        const value = this.getRegisterValue(parsed.src);
        const isZero = value === 0n;
        const shouldBranch = (opcode === 'cbz' && isZero) || (opcode === 'cbnz' && !isZero);
        
        if (shouldBranch) {
            if (!this.symbolTable.has(parsed.label)) {
                throw new Error(`Label '${parsed.label}' not found`);
            }
            const labelInfo = this.symbolTable.get(parsed.label);
            this.registers.pc = labelInfo.address;
            this.currentInstructionIndex = this.findInstructionIndexByAddress(this.registers.pc);
            return true; // PC modified
        }
        
        return false; // PC will be incremented normally
    }

    executeBl(parsed) {
        if (!parsed.label) {
            throw new Error(`Invalid bl instruction: missing label`);
        }
        
        if (!this.symbolTable.has(parsed.label)) {
            throw new Error(`Label '${parsed.label}' not found`);
        }
        
        // BL must store the return address (PC + 4) in x30 (LR)
        // PC currently points to the BL instruction being executed
        const returnAddress = this.registers.pc + 4n;
        this.setRegisterValue({ type: 'x', num: 30, name: 'x30' }, returnAddress);
        
        // Jump to label (BL is a branch, sets PC directly, no increment)
        const labelInfo = this.symbolTable.get(parsed.label);
        this.registers.pc = labelInfo.address;
        this.currentInstructionIndex = this.findInstructionIndexByAddress(this.registers.pc);
        
        // BL does NOT increment PC - it's a branch instruction
        return true; // PC modified by branch
    }

    executeRet(parsed) {
        // RET is a branch instruction - it sets PC directly, no increment
        // RET uses X30 (LR) by default, or specified register
        // RET does NOT modify stack, registers (except PC), or flags
        
        // Get the current instruction address (the RET being executed)
        // Note: this.registers.pc is set to the current instruction address by step() before executeInstruction
        const currentInstructionAddr = this.registers.pc;
        
        // Find the current instruction index
        const currentInstructionIndex = this.findInstructionIndexByAddress(currentInstructionAddr);
        
        // CRITICAL: Check if this RET belongs to _start/main function
        // _start/main is the top-level function - it has no caller, so RET must halt execution
        // If we check x30 first, it might contain a return address from a previous BL call,
        // which would cause an infinite loop (RET jumps back into _start)
        
        // We need to check if the current RET is within the _start/main function specifically,
        // not just any function that comes after the entry point
        if (this.entryPointLabel && this.entryPointAddress >= 0n) {
            const entryPointIndex = this.findInstructionIndexByAddress(this.entryPointAddress);
            
            // Check if current instruction is within the entry function range
            // (from entry point index to entry function end index)
            // This ensures we only end on RET in _start/main, not in other functions
            if (currentInstructionIndex >= entryPointIndex && 
                currentInstructionIndex < this.entryFunctionEndIndex &&
                currentInstructionAddr >= this.entryPointAddress) {
                // We're executing RET in _start/main - ALWAYS end the program immediately
                // Do NOT check x30 or return address - just halt immediately
                // This prevents the infinite loop where RET in _start uses x30 from a previous BL call
                this.registers.pc = 0n;
                return false; // End of program
            }
        }
        
        // For normal functions (not _start/main), get return address
        let retAddr;
        if (parsed.src) {
            retAddr = this.getRegisterValue(parsed.src);
        } else {
            // Default: use x30 (LR)
            retAddr = this.getRegisterValue({ type: 'x', num: 30, name: 'x30' });
        }
        
        // For normal functions (not _start/main), validate return address
        // Check if return address is 0 or invalid
        if (retAddr === 0n || retAddr < 0x00000000n) {
            // Invalid return address
            this.registers.pc = 0n;
            return false; // End of program
        }
        
        // Check if return address is within valid instruction range
        const instructionIndex = this.findInstructionIndexByAddress(retAddr);
        if (instructionIndex < 0 || instructionIndex >= this.instructions.length) {
            // Return address is outside valid instruction range
            this.registers.pc = 0n;
            return false; // End of program
        }
        
        // Valid return address - jump to it
        // RET is a branch instruction: PC = retAddr (no increment)
        this.registers.pc = retAddr;
        this.currentInstructionIndex = instructionIndex;
        
        // RET does NOT increment PC - it's a branch instruction
        return true; // PC modified by branch
    }

    getAllMemoryRegions() {
        const regions = {};
        const allAddresses = Array.from(this.memory.keys());
        
        // Ensure regionUsedSize is initialized
        if (!this.regionUsedSize) {
            this.regionUsedSize = {
                rodata: 0n,
                data: 0n,
                bss: 0n,
                heap: 0n,
                stack: 0n
            };
        }
        
        for (const [key, region] of Object.entries(this.memoryLayout)) {
            const regionData = [];
            const regionStart = Number(region.start);
            const regionEnd = Number(region.end);
            
            // Get all addresses in this region
            const regionAddresses = allAddresses.filter(addr => 
                addr >= regionStart && addr <= regionEnd
            );
            
            if (regionAddresses.length > 0) {
                // Collect all memory entries, reading at their natural alignment
                const processedAddrs = new Set();
                
                for (const addr of regionAddresses) {
                    if (processedAddrs.has(addr)) continue;
                    
                    // Determine the size of the value at this address
                    // Try to read as 8-byte, 4-byte, 2-byte, or 1-byte
                    let value = null;
                    let size = 1;
                    
                    // Check if this is the start of an 8-byte value
                    if (addr % 8 === 0 && addr + 7 <= regionEnd) {
                        try {
                            value = this.readMemory(BigInt(addr), 8);
                            size = 8;
                            for (let i = 0; i < 8; i++) processedAddrs.add(addr + i);
                        } catch (e) {
                            // Try smaller
                        }
                    }
                    
                    // Check if this is the start of a 4-byte value
                    if (value === null && addr % 4 === 0 && addr + 3 <= regionEnd) {
                        try {
                            value = this.readMemory(BigInt(addr), 4);
                            size = 4;
                            for (let i = 0; i < 4; i++) processedAddrs.add(addr + i);
                        } catch (e) {
                            // Try smaller
                        }
                    }
                    
                    // Check if this is the start of a 2-byte value
                    if (value === null && addr % 2 === 0 && addr + 1 <= regionEnd) {
                        try {
                            value = this.readMemory(BigInt(addr), 2);
                            size = 2;
                            for (let i = 0; i < 2; i++) processedAddrs.add(addr + i);
                        } catch (e) {
                            // Try 1-byte
                        }
                    }
                    
                    // Try 1-byte
                    if (value === null) {
                        try {
                            value = this.readMemory(BigInt(addr), 1);
                            size = 1;
                            processedAddrs.add(addr);
                        } catch (e) {
                            // Skip this address
                            continue;
                        }
                    }
                    
                    if (value !== null) {
                        regionData.push({
                            address: addr,
                            value: value,
                            size: size
                        });
                    }
                }
                
                regionData.sort((a, b) => a.address - b.address);
            }
            
            // Calculate used size for this region
            let usedSize = 0n;
            if (regionData.length > 0) {
                const lastEntry = regionData[regionData.length - 1];
                const lastAddr = BigInt(lastEntry.address) + BigInt(lastEntry.size);
                usedSize = lastAddr - BigInt(regionStart);
            } else if (this.regionUsedSize && this.regionUsedSize[key]) {
                // Use tracked used size if available (for BSS, etc.)
                usedSize = this.regionUsedSize[key];
            }
            
            // For stack, calculate used size based on SP position
            if (key === 'stack') {
                const stackTop = BigInt(regionEnd) + 1n;
                const currentSp = this.registers.sp;
                if (currentSp < stackTop) {
                    usedSize = stackTop - currentSp;
                }
            }
            
            // For heap, use tracked heap pointer
            if (key === 'heap' && this.heapPtr > BigInt(regionStart)) {
                usedSize = this.heapPtr - BigInt(regionStart);
            }
            
            // Calculate total size correctly (regionEnd and regionStart are Numbers, so convert back to BigInt for calculation)
            const totalSizeBigInt = BigInt(regionEnd) - BigInt(regionStart) + 1n;
            
            regions[key] = {
                name: region.name,
                start: regionStart,
                end: regionEnd,
                readonly: region.readonly,
                data: regionData,
                isEmpty: regionData.length === 0,
                usedSize: Number(usedSize),
                totalSize: Number(totalSizeBigInt)
            };
        }
        
        return regions;
    }
}


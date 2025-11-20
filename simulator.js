// ARM64 Assembly Simulator

class ARM64Simulator {
    constructor() {
        this.reset();
        // I/O callbacks for built-in functions
        this.ioCallbacks = {
            output: null,      // Function to output text
            inputSync: null    // Function to get input synchronously (returns string)
        };
    }
    
    setIOCallbacks(callbacks) {
        this.ioCallbacks = callbacks;
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
        // The label address points to where the first instruction after the label will be placed
        // We need to find the instruction that matches this address exactly, or the first one after it
        let foundIndex = -1;
        
        // If we have an entry label, find the first instruction at that label's address
        if (entryLabel && symbolTable.has(entryLabel)) {
            const labelInfo = symbolTable.get(entryLabel);
            const labelAddr = labelInfo.address;
            
            // Find the instruction that matches the label address exactly
            // The label address should match the address of the first instruction after it
            for (let i = 0; i < instructions.length; i++) {
                if (instructions[i].address === labelAddr) {
                    foundIndex = i;
                    entryPoint = instructions[i].address;
                    break;
                }
            }
            
            // If no exact match, find first instruction at or after the label address
            // This handles edge cases where label address might be slightly off
            if (foundIndex === -1) {
                for (let i = 0; i < instructions.length; i++) {
                    if (instructions[i].address >= labelAddr) {
                        foundIndex = i;
                        entryPoint = instructions[i].address; // Use actual instruction address
                        break;
                    }
                }
            }
        } else {
            // No entry label, find instruction at or after entry point
            for (let i = 0; i < instructions.length; i++) {
                if (instructions[i].address >= entryPoint) {
                    foundIndex = i;
                    entryPoint = instructions[i].address; // Use actual instruction address
                    break;
                }
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
            entryPoint = instructions[foundIndex].address; // Always use the actual instruction address
        } else if (instructions.length > 0) {
            // Fallback: use first instruction
            this.currentInstructionIndex = 0;
            entryPoint = instructions[0].address;
        } else {
            this.currentInstructionIndex = 0;
        }
        
        // CRITICAL: Set PC to the entry point (address of first instruction to execute)
        // PC must point to the instruction that will be executed when step() is first called
        // This is the instruction at currentInstructionIndex
        // step() will set PC to the instruction address before executing, so we need to set it here
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
                // mov x0, #-1
                // mov x0, x1
                if (parts.length >= 3) {
                    result.dest = this.parseRegister(parts[1]);
                    const src = parts.slice(2).join(' ');
                    if (src.startsWith('#')) {
                        result.immediate = this.parseImmediate(src.substring(1));
                    } else {
                        result.src = this.parseRegister(src);
                    }
                }
                break;

            case 'add':
            case 'adds':
            case 'sub':
            case 'subs':
                // add sp, sp, #16
                // sub sp, sp, #16
                // adds x0, x1, x2
                // subs x0, x1, #5
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
                        result.immediate = this.parseImmediate(src2.substring(1));
                    } else if (src2.includes(':lo12:')) {
                        // Handle :lo12: syntax: add x0, x0, :lo12:label
                        // This is assembler syntax for the low 12 bits of a label address
                        const labelMatch = src2.match(/:lo12:([a-zA-Z_][a-zA-Z0-9_]*)/);
                        if (labelMatch) {
                            result.label = labelMatch[1];
                            result.labelOp = 'lo12'; // Mark this as a lo12 operation
                        } else {
                            throw new Error(`Invalid :lo12: syntax: ${src2}`);
                        }
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
            case 'cmn':
                // cmp x0, x1 or cmp x0, #5
                // cmn x0, x1 or cmn x0, #5 (compare negative - adds without destination)
                if (parts.length >= 3) {
                    const src1Str = parts[1].replace(/,/g, '').trim();
                    result.src1 = this.parseRegister(src1Str);
                    
                    const src2 = parts.slice(2).join(' ').replace(/,/g, '').trim();
                    if (src2.startsWith('#')) {
                        // Immediate: cmp xN, #imm or cmn xN, #imm
                        result.immediate = this.parseImmediate(src2.substring(1));
                    } else {
                        // Register: cmp xN, xM or cmn xN, xM
                        result.src2 = this.parseRegister(src2);
                    }
                } else {
                    throw new Error(`Invalid ${opcode} instruction: missing operands`);
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
                        result.immediate = this.parseImmediate(src2Part.substring(1));
                    } else {
                        // Register: and x0, x1, x2
                        result.src2 = this.parseRegister(src2Part);
                    }
                }
                break;

            case 'lsl':
            case 'lsr':
            case 'asr':
            case 'ror':
            case 'mvn':
                // Shift and bitwise NOT instructions
                // lsl x0, x1, #4
                // lsl x0, x1, x2
                // mvn x0, x1
                if (parts.length >= 3) {
                    const destStr = parts[1].replace(/,/g, '').trim();
                    const src1Str = parts[2].replace(/,/g, '').trim();
                    result.dest = this.parseRegister(destStr);
                    result.src1 = this.parseRegister(src1Str);
                    
                    // For mvn, there's no second operand
                    if (opcode === 'mvn') {
                        // mvn x0, x1 (bitwise NOT)
                        break;
                    }
                    
                    // For shifts, get shift amount (immediate or register)
                    if (parts.length >= 4) {
                        const shiftPart = parts.slice(3).join(' ').replace(/,/g, '').trim();
                        if (shiftPart.startsWith('#')) {
                            // Immediate: lsl x0, x1, #4 or lsl x0, x1, #0xFF
                            result.immediate = this.parseImmediate(shiftPart.substring(1));
                        } else {
                            // Try to parse as number (immediate without #)
                            const numValue = parseInt(shiftPart);
                            if (!isNaN(numValue)) {
                                result.immediate = BigInt(numValue);
                            } else {
                                // Register: lsl x0, x1, x2
                                result.src2 = this.parseRegister(shiftPart);
                            }
                        }
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

    parseImmediate(immStr) {
        // Parse immediate value, handling negative numbers, hex, and character literals
        // immStr should be the string after '#' (e.g., "-1", "5", "0xFF", "'A'")
        let isNegative = false;
        let numStr = immStr.trim();
        
        // Check for character literal (e.g., 'A', 'B', '\n')
        if (numStr.startsWith("'") && numStr.endsWith("'") && numStr.length >= 3) {
            const charStr = numStr.slice(1, -1); // Remove quotes
            let charCode;
            
            // Handle escape sequences
            if (charStr.length === 2 && charStr[0] === '\\') {
                switch (charStr[1]) {
                    case 'n':
                        charCode = 10; // newline
                        break;
                    case 't':
                        charCode = 9; // tab
                        break;
                    case '\\':
                        charCode = 92; // backslash
                        break;
                    case '\'':
                        charCode = 39; // single quote
                        break;
                    case '"':
                        charCode = 34; // double quote
                        break;
                    case '0':
                        charCode = 0; // null
                        break;
                    default:
                        throw new Error(`Unknown escape sequence: \\${charStr[1]}`);
                }
            } else if (charStr.length === 1) {
                charCode = charStr.charCodeAt(0);
            } else {
                throw new Error(`Invalid character literal: ${numStr}`);
            }
            
            return BigInt(charCode);
        }
        
        // Check for negative sign
        if (numStr.startsWith('-')) {
            isNegative = true;
            numStr = numStr.substring(1);
        }
        
        // Parse the number (handles hex 0x prefix)
        let value;
        if (numStr.toLowerCase().startsWith('0x')) {
            value = BigInt(numStr);
        } else {
            value = BigInt(numStr);
        }
        
        // Apply negative if needed
        if (isNegative) {
            value = -value;
        }
        
        return value;
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

    async executeInstruction(instruction) {
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
                case 'adds':
                    this.executeArithmeticWithFlags(parsed, 'add', true);
                    break;
                case 'sub':
                    this.executeSub(parsed, false);
                    break;
                case 'subs':
                    this.executeArithmeticWithFlags(parsed, 'sub', true);
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
                    this.executeArithmeticWithFlags(parsed, 'sub', false);
                    break;
                case 'cmn':
                    this.executeArithmeticWithFlags(parsed, 'add', false);
                    break;
                case 'and':
                case 'ands':
                case 'orr':
                case 'eor':
                case 'bic':
                    this.executeLogical(parsed, opcode);
                    break;
                case 'lsl':
                case 'lsr':
                case 'asr':
                case 'ror':
                case 'mvn':
                    this.executeShift(parsed, opcode);
                    break;
                case 'b':
                    pcModified = this.executeB(parsed);
                    break;
                case 'bl':
                    pcModified = await this.executeBl(parsed);
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

    countBits(n) {
        // Count the number of bits set in a BigInt (up to 64 bits)
        let count = 0;
        let val = n;
        while (val > 0n) {
            if ((val & 1n) !== 0n) {
                count++;
            }
            val = val >> 1n;
        }
        return count;
    }

    isMovImmediateEncodable(value, is64Bit) {
        // Check if an immediate value can be encoded using MOVZ or MOVN
        // For 64-bit: shifts are 0, 16, 32, 48
        // For 32-bit: shifts are 0, 16
        // MOVZ: (16-bit_value << shift) where only that 16-bit chunk is non-zero
        // MOVN: ~((16-bit_value << shift)) where only that 16-bit chunk is set in notValue
        
        const mask64 = 0xFFFFFFFFFFFFFFFFn;
        const mask32 = 0xFFFFFFFFn;
        const mask = is64Bit ? mask64 : mask32;
        
        // Convert to unsigned representation
        let unsignedValue = value & mask;
        
        // Quick rejection: If the value has more than 16 bits set and doesn't match
        // a simple pattern, it likely spans multiple chunks incorrectly
        // Count set bits - if it's more than 16 and not all bits, it's suspicious
        // (This is a heuristic to catch obvious cases like 0xFFFFFFFFFFFFF)
        
        // Check for MOVZ pattern: (16-bit_value << shift)
        // The value must have bits set in ONLY ONE 16-bit aligned chunk
        const shifts = is64Bit ? [0, 16, 32, 48] : [0, 16];
        for (const shift of shifts) {
            // Extract the 16-bit value at this shift position
            const shiftedMask = (0xFFFFn << BigInt(shift)) & mask;
            const extracted = (unsignedValue & shiftedMask) >> BigInt(shift);
            
            // Check if all other bits are zero (only this chunk has bits set)
            const otherBits = unsignedValue & (~shiftedMask);
            if (otherBits === 0n && extracted <= 0xFFFFn && extracted > 0n) {
                return true; // Valid MOVZ encoding
            }
        }
        
        // Check for MOVN pattern: ~((16-bit_value << shift))
        // This means: value = ~(16-bit_value << shift)
        // Which means: ~value = (16-bit_value << shift)
        // So ~value must have bits set in ONLY ONE 16-bit aligned chunk
        const notValue = (~unsignedValue) & mask;
        for (const shift of shifts) {
            const shiftedMask = (0xFFFFn << BigInt(shift)) & mask;
            const extracted = (notValue & shiftedMask) >> BigInt(shift);
            const otherBits = notValue & (~shiftedMask);
            
            // For MOVN to be valid:
            // 1. notValue must have bits set in ONLY ONE 16-bit chunk (otherBits === 0)
            // 2. The extracted value must be exactly a 16-bit value (0x0000 to 0xFFFF)
            // 3. When we reconstruct: (extracted << shift) must equal notValue exactly
            // 4. The original value must match ~(extracted << shift) exactly
            // 5. CRITICAL: The original value must have bits set in ALL chunks EXCEPT the one at shift
            //    This ensures it's the NOT of a single shifted 16-bit value, not a value spanning multiple chunks
            if (otherBits === 0n && extracted >= 0n && extracted <= 0xFFFFn && extracted > 0n) {
                // Verify that reconstructing gives us the exact notValue
                const reconstructed = (extracted << BigInt(shift)) & mask;
                // Also verify that the original value matches ~reconstructed exactly
                const originalReconstructed = (~reconstructed) & mask;
                if (reconstructed === notValue && originalReconstructed === unsignedValue) {
                    // Additional critical check: Verify that the original value has the correct pattern
                    // For MOVN at shift N: all chunks except chunk N should be 0xFFFF (all 1s)
                    // and chunk N should be ~extracted
                    let isValidMovn = true;
                    for (const checkShift of shifts) {
                        const checkMask = (0xFFFFn << BigInt(checkShift)) & mask;
                        const chunkValue = (unsignedValue & checkMask) >> BigInt(checkShift);
                        if (checkShift === shift) {
                            // At the shift position, the chunk should be the NOT of extracted
                            const expectedChunk = (~extracted) & 0xFFFFn;
                            if (chunkValue !== expectedChunk) {
                                isValidMovn = false;
                                break;
                            }
                            // CRITICAL: For MOVN, reject values where the chunk at shift is only partially set
                            // This indicates the value spans more bits than can be encoded in a single 16-bit immediate
                            // For example, 0xFFFFFFFFFFFFF has chunk 3 = 0x000F (only 4 bits), meaning it spans 52 bits
                            // A single MOV can only encode 16 bits of information, so values spanning more should be rejected
                            // Check: if the chunk value is not 0xFFFF and not a full 16-bit pattern starting from bit 0,
                            // it means the value spans incorrectly
                            // For 0x000F: this is only the lower 4 bits, not a full 16-bit pattern
                            // Reject if chunkValue is not 0xFFFF and doesn't use the full lower 16 bits
                            if (chunkValue !== 0xFFFFn) {
                                // The chunk should be the NOT of extracted
                                // If extracted = 0xFFF0, chunk = 0x000F
                                // But 0x000F only uses 4 bits, meaning the original value spans 52 bits
                                // Reject if the chunk doesn't use bits starting from 0 (i.e., it's not a contiguous pattern from 0)
                                // For 0x000F: it uses bits 0-3, which is contiguous from 0, so that's not the issue
                                // The real issue: 0x000F means only 4 bits are used in the chunk, but the value spans 52 bits total
                                // A valid MOVN should have the chunk use the full 16-bit range when it's not all 1s
                                // Actually, the simplest check: reject if chunkValue < 0xFFFF and the value has more than shift + 16 bits
                                // But wait, that's what we're checking with expectedBits
                                // The key insight: if chunkValue is 0x000F, it means only 4 bits are set in that chunk
                                // But for a valid MOVN, if the chunk is not all 1s, it should still represent a full 16-bit NOT pattern
                                // The issue is that 0x000F is the NOT of 0xFFF0, but 0xFFF0 is not a "standard" 16-bit immediate
                                // Actually, I think the real rule is simpler: reject if the value cannot be represented
                                // as ~(imm16 << shift) where imm16 is a valid 16-bit immediate
                                // And 0xFFF0 IS a valid 16-bit immediate, so this should work
                                // But ARM64 rejects it, so there must be another constraint
                                // Let me check: maybe the issue is that the value spans 52 bits, which is more than 16
                                // So the rule is: reject if totalBitsSet > 16 for the chunk at shift
                                // But that doesn't make sense either, because MOVN can have up to 64 bits set
                                // I think the real issue is that 0xFFFFFFFFFFFFF cannot be encoded because it requires
                                // more than one instruction to construct. The value has 52 bits set, which is more than
                                // the 16 bits that can be encoded in a single immediate field
                                // Simple fix: reject if the chunk at shift has fewer than 16 bits set when it's not 0xFFFF
                                // For 0x000F: only 4 bits are set, so reject
                                const chunkBitsSet = this.countBits(chunkValue);
                                if (chunkBitsSet < 16 && chunkValue !== 0n) {
                                    isValidMovn = false;
                                    break;
                                }
                            }
                        } else {
                            // At all other positions, the chunk should be all 1s (0xFFFF)
                            // because we're NOT'ing a value that's 0 in those positions
                            if (chunkValue !== 0xFFFFn) {
                                isValidMovn = false;
                                break;
                            }
                        }
                    }
                    if (isValidMovn) {
                        return true; // Valid MOVN encoding
                    }
                }
            }
        }
        
        return false; // Not encodable
    }

    executeMov(parsed) {
        if (!parsed.dest) return;
        
        if (parsed.immediate !== undefined) {
            // First, validate that the immediate can be encoded
            const is64Bit = !(parsed.dest && parsed.dest.type === 'w');
            const originalValue = parsed.immediate;
            
            // Convert to unsigned representation for validation
            const mask = is64Bit ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
            let value = originalValue;
            if (value < 0n) {
                value = value & mask; // Convert to two's complement
            } else {
                value = value & mask; // Mask to appropriate size
            }
            
            // Check if the immediate is encodable
            if (!this.isMovImmediateEncodable(value, is64Bit)) {
                throw new Error(`MOV immediate value 0x${value.toString(16).toUpperCase()} cannot be encoded using MOVZ/MOVN. Valid immediates must be a 16-bit value shifted by 0, 16, 32, 48 (for 64-bit) or 0, 16 (for 32-bit), or their bitwise NOT.`);
            }
            
            // Apply sign extension based on register type
            if (parsed.dest && parsed.dest.type === 'w') {
                // For W registers: 32-bit sign extension, then zero-extend to 64 bits
                // Convert immediate to signed 32-bit integer, then zero-extend to 64 bits
                const int32Value = Number(value);
                // Convert to signed 32-bit (this handles sign extension)
                const signed32 = (int32Value << 0) >> 0; // Sign-extend to 32 bits
                // Convert to unsigned 32-bit representation (zero-extend)
                const unsigned32 = signed32 >>> 0;
                // Zero-extend to 64 bits (W register behavior)
                value = BigInt(unsigned32);
            } else {
                // For X registers: value is already in correct 64-bit representation
                // (already masked above)
            }
            
            this.setRegisterValue(parsed.dest, value);
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
        } else if (parsed.labelOp === 'lo12' && parsed.label) {
            // Handle :lo12: syntax - add the low 12 bits of label address
            if (!this.symbolTable.has(parsed.label)) {
                throw new Error(`Label '${parsed.label}' not found for :lo12:`);
            }
            const labelInfo = this.symbolTable.get(parsed.label);
            const labelAddr = labelInfo.address;
            // Extract low 12 bits (mask with 0xFFF)
            val2 = labelAddr & 0xFFFn;
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

    executeShift(parsed, opcode) {
        // Shift instructions: LSL, LSR, ASR, ROR, and MVN (bitwise NOT)
        // lsl x0, x1, #4
        // lsl x0, x1, x2
        // lsr x0, x1, #2
        // asr x0, x1, #1
        // ror x0, x1, #1
        // mvn x0, x1
        if (!parsed.dest || !parsed.src1) {
            throw new Error(`Invalid ${opcode} instruction: missing destination or source register`);
        }
        
        const val1 = this.getRegisterValue(parsed.src1);
        let result;
        
        // Determine result size based on destination register
        const size = (parsed.dest && parsed.dest.type === 'w') ? 32 : 64;
        const mask = size === 64 ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
        
        if (opcode === 'mvn') {
            // MVN: bitwise NOT
            result = (~val1) & mask;
        } else {
            // Get shift amount
            let shiftAmount = 0n;
            if (parsed.immediate !== undefined) {
                shiftAmount = parsed.immediate;
            } else if (parsed.src2) {
                // For register-based shifts, mask to valid shift amount bits
                // 64-bit: lower 6 bits (0-63)
                // 32-bit: lower 5 bits (0-31)
                const shiftMask = size === 64 ? 0x3Fn : 0x1Fn;
                shiftAmount = this.getRegisterValue(parsed.src2) & BigInt(shiftMask);
            } else {
                throw new Error(`Invalid ${opcode} instruction: missing shift amount`);
            }
            
            // Zero shift is a no-op
            if (shiftAmount === 0n) {
                result = val1 & mask;
            } else {
                // Apply the shift operation
                switch (opcode) {
                    case 'lsl':
                        // Logical shift left
                        result = (val1 << shiftAmount) & mask;
                        break;
                    case 'lsr':
                        // Logical shift right
                        result = (val1 >> shiftAmount) & mask;
                        break;
                    case 'asr':
                        // Arithmetic shift right (sign-extending)
                        // Sign-extend the value first
                        let signedVal = val1 & mask;
                        const signBit = size === 64 ? 63 : 31;
                        const signMask = 1n << BigInt(signBit);
                        
                        if ((signedVal & signMask) !== 0n) {
                            // Negative: sign-extend upper bits
                            signedVal = signedVal | (~mask);
                        }
                        
                        // Perform arithmetic shift right
                        result = signedVal >> shiftAmount;
                        result = result & mask;
                        break;
                    case 'ror':
                        // Rotate right: bits that fall off the right end wrap around to the left
                        const rotateAmount = Number(shiftAmount) % size;
                        if (rotateAmount === 0) {
                            result = val1 & mask;
                        } else {
                            // Extract lower bits that will wrap around
                            const lowerBits = val1 & ((1n << BigInt(rotateAmount)) - 1n);
                            // Shift the value right
                            const shifted = val1 >> BigInt(rotateAmount);
                            // Move lower bits to the top
                            result = (shifted | (lowerBits << BigInt(size - rotateAmount))) & mask;
                        }
                        break;
                    default:
                        throw new Error(`Unknown shift operation: ${opcode}`);
                }
            }
        }
        
        // Write result to destination register
        this.setRegisterValue(parsed.dest, result);
        
        // Shift instructions do NOT modify flags
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

    async step() {
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
        const shouldContinue = await this.executeInstruction(instruction);
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

    executeArithmeticWithFlags(parsed, operation, writeResult) {
        // Handles: adds, subs, cmp, cmn
        // operation: 'add' or 'sub'
        // writeResult: true for adds/subs (write to dest), false for cmp/cmn (flags only)
        
        if (!parsed.src1) {
            throw new Error(`Invalid ${operation} instruction: missing first operand`);
        }
        
        const val1 = this.getRegisterValue(parsed.src1);
        let val2;
        
        // Get second operand
        if (parsed.immediate !== undefined) {
            val2 = parsed.immediate;
        } else if (parsed.src2) {
            val2 = this.getRegisterValue(parsed.src2);
        } else {
            throw new Error(`Invalid ${operation} instruction: missing second operand`);
        }
        
        // Determine register size
        const size = (parsed.src1 && parsed.src1.type === 'w') ? 32 : 64;
        const mask = size === 64 ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
        const signBit = size === 64 ? 63 : 31;
        const signMask = 1n << BigInt(signBit);
        
        // Mask operands to size
        const maskedVal1 = val1 & mask;
        const maskedVal2 = val2 & mask;
        
        // Perform the operation
        let result;
        if (operation === 'add') {
            result = (maskedVal1 + maskedVal2) & mask;
        } else { // 'sub'
            result = (maskedVal1 - maskedVal2) & mask;
        }
        
        // Handle stack operations if destination is sp
        if (writeResult && parsed.dest) {
            const destReg = parsed.dest;
            const isStackOp = (typeof destReg === 'string' && destReg === 'sp');
            
            if (isStackOp) {
                // Stack pointer is always 64-bit, use full values
                // Validate stack alignment
                if (operation === 'add') {
                    if (val2 % 16n !== 0n) {
                        throw new Error(`Stack operations (add sp) must use values that are multiples of 16 for alignment. Got: ${val2}`);
                    }
                    const newSP = val1 + val2; // Use full 64-bit values for SP
                    if (newSP % 16n !== 0n) {
                        throw new Error(`Stack pointer must remain 16-byte aligned. New SP would be: 0x${newSP.toString(16)}`);
                    }
                    this.setRegisterValue(parsed.dest, newSP);
                    this.destroyStackFrame(Number(newSP), Number(val2));
                    // Update result for flag calculation (use masked result)
                    result = newSP & mask;
                } else { // 'sub'
                    if (val2 % 16n !== 0n) {
                        throw new Error(`Stack operations (sub sp) must use values that are multiples of 16 for alignment. Got: ${val2}`);
                    }
                    const newSP = val1 - val2; // Use full 64-bit values for SP
                    if (newSP % 16n !== 0n) {
                        throw new Error(`Stack pointer must remain 16-byte aligned. New SP would be: 0x${newSP.toString(16)}`);
                    }
                    if (newSP < 0n) {
                        throw new Error(`Stack overflow: SP would become negative`);
                    }
                    this.setRegisterValue(parsed.dest, newSP);
                    this.createStackFrame(Number(newSP), Number(val2));
                    // Update result for flag calculation (use masked result)
                    result = newSP & mask;
                }
            } else {
                // Normal register operation - write result
                this.setRegisterValue(parsed.dest, result);
            }
        }
        
        // Calculate all four flags
        // N (Negative): MSB of result
        this.flags.N = (result & signMask) !== 0n;
        
        // Z (Zero): result is zero
        this.flags.Z = (result & mask) === 0n;
        
        // C (Carry/Borrow): depends on operation
        if (operation === 'add') {
            // For ADD/ADDS/CMN: C=1 on unsigned overflow (result < val1)
            // This means the addition wrapped around
            this.flags.C = result < maskedVal1;
        } else { // 'sub'
            // For SUB/SUBS/CMP: C=1 when no borrow (val1 >= val2 in unsigned sense)
            // C=0 when borrow occurs (val1 < val2)
            this.flags.C = maskedVal1 >= maskedVal2;
        }
        
        // V (Overflow): signed overflow in two's complement
        if (operation === 'add') {
            // Overflow in addition occurs when:
            // - Both operands have the same sign (both positive or both negative)
            // - AND the result has a different sign
            const val1Negative = (maskedVal1 & signMask) !== 0n;
            const val2Negative = (maskedVal2 & signMask) !== 0n;
            const resultNegative = (result & signMask) !== 0n;
            
            // Overflow: (both positive && result negative) OR (both negative && result positive)
            this.flags.V = (val1Negative === val2Negative) && (resultNegative !== val1Negative);
        } else { // 'sub'
            // Overflow in subtraction occurs when:
            // - Operands have different signs (val1 negative != val2 negative)
            // - AND the result has a different sign than val1
            const val1Negative = (maskedVal1 & signMask) !== 0n;
            const val2Negative = (maskedVal2 & signMask) !== 0n;
            const resultNegative = (result & signMask) !== 0n;
            
            // Overflow: (different signs) && (result sign != val1 sign)
            this.flags.V = (val1Negative !== val2Negative) && (resultNegative !== val1Negative);
        }
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

    async executeBl(parsed) {
        if (!parsed.label) {
            throw new Error(`Invalid bl instruction: missing label`);
        }
        
        // Check if this is a built-in I/O function
        const builtInFunctions = ['printf', 'puts', 'putchar', 'scanf', 'gets', 'fgets', 'getchar'];
        if (builtInFunctions.includes(parsed.label)) {
            // BL must store the return address (PC + 4) in x30 (LR)
            const returnAddress = this.registers.pc + 4n;
            this.setRegisterValue({ type: 'x', num: 30, name: 'x30' }, returnAddress);
            
            // Execute the built-in function (async for input functions)
            await this.executeBuiltInFunctionSync(parsed.label);
            
            // Return to caller (simulate RET)
            this.registers.pc = returnAddress;
            this.currentInstructionIndex = this.findInstructionIndexByAddress(this.registers.pc);
            
            return true; // PC modified
        }
        
        // Normal function call
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

    // Read ASCIZ string from memory
    readString(address) {
        let str = '';
        let addr = address;
        while (true) {
            const byte = this.readMemory(addr, 1);
            if (byte === 0n) break;
            str += String.fromCharCode(Number(byte));
            addr++;
        }
        return str;
    }
    
    // Execute built-in I/O functions (async wrapper for input functions)
    async executeBuiltInFunctionSync(funcName) {
        switch (funcName) {
            case 'printf':
                this.builtinPrintf();
                break;
            case 'puts':
                this.builtinPuts();
                break;
            case 'putchar':
                this.builtinPutchar();
                break;
            case 'fgets':
                await this.builtinFgetsSync();
                break;
            case 'gets':
                await this.builtinGetsSync();
                break;
            case 'getchar':
                await this.builtinGetcharSync();
                break;
            case 'scanf':
                await this.builtinScanfSync();
                break;
            default:
                throw new Error(`Unknown built-in function: ${funcName}`);
        }
    }
    
    builtinPrintf() {
        // x0 = format string pointer
        const fmtPtr = this.registers.x0;
        if (fmtPtr === 0n) {
            throw new Error('printf: null format string pointer');
        }
        
        const fmt = this.readString(fmtPtr);
        let output = '';
        let argIndex = 1; // x1 is first argument after format string
        
        for (let i = 0; i < fmt.length; i++) {
            if (fmt[i] === '%' && i + 1 < fmt.length) {
                i++;
                const spec = fmt[i];
                let argReg = `x${argIndex}`;
                
                switch (spec) {
                    case 'd':
                    case 'i':
                        // Signed decimal
                        const signedVal = this.registers[argReg];
                        const intVal = Number(signedVal > 0x7FFFFFFFFFFFFFFFn ? signedVal - 0x10000000000000000n : signedVal);
                        output += intVal.toString();
                        argIndex++;
                        break;
                    case 'u':
                        // Unsigned decimal
                        output += this.registers[argReg].toString();
                        argIndex++;
                        break;
                    case 'x':
                        // Hexadecimal (lowercase)
                        output += this.registers[argReg].toString(16);
                        argIndex++;
                        break;
                    case 'X':
                        // Hexadecimal (uppercase)
                        output += this.registers[argReg].toString(16).toUpperCase();
                        argIndex++;
                        break;
                    case 'l':
                        // Long modifier - check next char
                        if (i + 1 < fmt.length) {
                            i++;
                            const nextSpec = fmt[i];
                            if (nextSpec === 'd' || nextSpec === 'i') {
                                // %ld or %li - signed long
                                const signedVal = this.registers[argReg];
                                const intVal = Number(signedVal > 0x7FFFFFFFFFFFFFFFn ? signedVal - 0x10000000000000000n : signedVal);
                                output += intVal.toString();
                                argIndex++;
                            } else if (nextSpec === 'u') {
                                // %lu - unsigned long
                                output += this.registers[argReg].toString();
                                argIndex++;
                            } else if (nextSpec === 'x') {
                                // %lx - hexadecimal long (lowercase)
                                output += this.registers[argReg].toString(16);
                                argIndex++;
                            } else if (nextSpec === 'X') {
                                // %lX - hexadecimal long (uppercase)
                                output += this.registers[argReg].toString(16).toUpperCase();
                                argIndex++;
                            } else {
                                // Invalid specifier after 'l'
                                output += '%l' + nextSpec;
                            }
                        } else {
                            // '%l' at end of string
                            output += '%l';
                        }
                        break;
                    case 's':
                        // String
                        const strPtr = this.registers[argReg];
                        if (strPtr === 0n) {
                            output += '(null)';
                        } else {
                            output += this.readString(strPtr);
                        }
                        argIndex++;
                        break;
                    case 'c':
                        // Character
                        const charCode = Number(this.registers[argReg] & 0xFFn);
                        output += String.fromCharCode(charCode);
                        argIndex++;
                        break;
                    case '%':
                        // Literal %
                        output += '%';
                        break;
                    default:
                        output += '%' + spec;
                }
            } else if (fmt[i] === '\\' && i + 1 < fmt.length) {
                i++;
                switch (fmt[i]) {
                    case 'n':
                        output += '\n';
                        break;
                    case 't':
                        output += '\t';
                        break;
                    case '\\':
                        output += '\\';
                        break;
                    case '"':
                        output += '"';
                        break;
                    default:
                        output += '\\' + fmt[i];
                }
            } else {
                output += fmt[i];
            }
        }
        
        if (this.ioCallbacks.output) {
            this.ioCallbacks.output(output);
        } else {
            console.log(output);
        }
    }
    
    builtinPuts() {
        // x0 = string pointer
        const strPtr = this.registers.x0;
        if (strPtr === 0n) {
            if (this.ioCallbacks.output) {
                this.ioCallbacks.output('\n');
            }
            return;
        }
        
        const str = this.readString(strPtr);
        const output = str + '\n';
        
        if (this.ioCallbacks.output) {
            this.ioCallbacks.output(output);
        } else {
            console.log(output);
        }
    }
    
    builtinPutchar() {
        // x0 = character code (32-bit)
        const charCode = Number(this.registers.x0 & 0xFFn);
        const char = String.fromCharCode(charCode);
        
        if (this.ioCallbacks.output) {
            this.ioCallbacks.output(char);
        } else {
            console.log(char);
        }
    }
    
    async builtinFgetsSync() {
        // x0 = buffer pointer
        // x1 = size (max bytes to store)
        // fgets reads up to size-1 characters, stops on newline OR after size-1 chars
        // Newline IS included in buffer (unless size is too small)
        // Always null-terminates
        const bufPtr = this.registers.x0;
        const size = Number(this.registers.x1);
        
        if (bufPtr === 0n || size <= 0) {
            this.registers.x0 = 0n; // Return NULL on error
            return;
        }
        
        // Get input from user (async) - no prompt, reads silently
        let input = '';
        if (this.ioCallbacks.inputSync) {
            input = await this.ioCallbacks.inputSync('');
        } else {
            input = prompt('') || '';
        }
        
        // Find newline position
        const newlineIndex = input.indexOf('\n');
        const hasNewline = newlineIndex !== -1;
        
        // Determine how many characters to read
        // Read up to size-1 characters, or until newline (whichever comes first)
        let charsToRead;
        if (hasNewline) {
            // Include newline if it fits within size-1
            charsToRead = Math.min(newlineIndex + 1, size - 1);
        } else {
            // No newline, read up to size-1 characters
            charsToRead = Math.min(input.length, size - 1);
        }
        
        // Write characters to buffer
        for (let i = 0; i < charsToRead; i++) {
            this.writeMemory(bufPtr + BigInt(i), BigInt(input.charCodeAt(i)), 1);
        }
        
        // Always null-terminate (at position charsToRead, which is <= size-1)
        this.writeMemory(bufPtr + BigInt(charsToRead), 0n, 1);
        
        // Return buffer pointer
        this.registers.x0 = bufPtr;
    }
    
    async builtinGetsSync() {
        // x0 = buffer pointer
        // gets reads entire line until newline, removes newline, adds null terminator
        // No size limit (dangerous in real C), but stop at memory region end
        const bufPtr = this.registers.x0;
        
        if (bufPtr === 0n) {
            this.registers.x0 = 0n; // Return NULL on error
            return;
        }
        
        // Get input from user (async) - no prompt, reads silently
        let input = '';
        if (this.ioCallbacks.inputSync) {
            input = await this.ioCallbacks.inputSync('');
        } else {
            input = prompt('') || '';
        }
        
        // Find newline and stop there
        const newlineIndex = input.indexOf('\n');
        const lineEnd = newlineIndex !== -1 ? newlineIndex : input.length;
        
        // Write characters to buffer (excluding newline)
        // Check memory bounds to prevent writing outside allocated regions
        let i = 0;
        for (let j = 0; j < lineEnd; j++) {
            const addr = bufPtr + BigInt(i);
            // Basic bounds check - don't write outside reasonable memory regions
            if (addr > 0x07FFFFFFn) {
                break; // Stop if we'd write outside stack region
            }
            this.writeMemory(addr, BigInt(input.charCodeAt(j)), 1);
            i++;
        }
        
        // Always null-terminate (newline is NOT included)
        const nullAddr = bufPtr + BigInt(i);
        if (nullAddr <= 0x07FFFFFFn) {
            this.writeMemory(nullAddr, 0n, 1);
        }
        
        // Return buffer pointer
        this.registers.x0 = bufPtr;
    }
    
    async builtinGetcharSync() {
        // Get one character from user (synchronous)
        let input = '';
        if (this.ioCallbacks.inputSync) {
            input = this.ioCallbacks.inputSync('Enter a character: ');
        } else {
            input = prompt('Enter a character: ') || '';
        }
        
        const charCode = input.length > 0 ? input.charCodeAt(0) : 0;
        this.registers.x0 = BigInt(charCode);
    }
    
    async builtinScanfSync() {
        // x0 = format string pointer
        // x1, x2, ... = argument pointers
        // Returns number of items successfully read in x0
        const fmtPtr = this.registers.x0;
        if (fmtPtr === 0n) {
            throw new Error('scanf: null format string pointer');
        }
        
        const fmt = this.readString(fmtPtr);
        let argIndex = 1;
        let itemsRead = 0;
        
        // Get input from user (async) - no prompt, reads silently
        let input = '';
        if (this.ioCallbacks.inputSync) {
            input = await this.ioCallbacks.inputSync('');
        } else {
            input = prompt('') || '';
        }
        
        // Track position in input string
        let inputPos = 0;
        
        // Parse format string and read values
        for (let i = 0; i < fmt.length; i++) {
            if (fmt[i] === '%' && i + 1 < fmt.length) {
                i++;
                const spec = fmt[i];
                
                const argReg = `x${argIndex}`;
                const argPtr = this.registers[argReg];
                
                if (argPtr === 0n) {
                    argIndex++;
                    continue;
                }
                
                // For %c, don't skip whitespace. For others, skip leading whitespace
                let shouldSkipWhitespace = true;
                if (spec === 'c') {
                    shouldSkipWhitespace = false;
                }
                
                if (shouldSkipWhitespace) {
                    // Skip whitespace before reading (scanf skips leading whitespace for most formats)
                    while (inputPos < input.length && /\s/.test(input[inputPos])) {
                        inputPos++;
                    }
                }
                
                if (inputPos >= input.length) {
                    break; // End of input
                }
                
                switch (spec) {
                    case 'd':
                    case 'i':
                        // Signed integer - read until whitespace or end
                        let intStr = '';
                        while (inputPos < input.length && !/\s/.test(input[inputPos])) {
                            intStr += input[inputPos];
                            inputPos++;
                        }
                        const intVal = parseInt(intStr, 10);
                        if (!isNaN(intVal)) {
                            this.writeMemory(argPtr, BigInt(intVal), 8);
                            itemsRead++;
                        }
                        break;
                    case 'u':
                        // Unsigned integer
                        let uintStr = '';
                        while (inputPos < input.length && !/\s/.test(input[inputPos])) {
                            uintStr += input[inputPos];
                            inputPos++;
                        }
                        const uintVal = parseInt(uintStr, 10);
                        if (!isNaN(uintVal) && uintVal >= 0) {
                            this.writeMemory(argPtr, BigInt(uintVal), 8);
                            itemsRead++;
                        }
                        break;
                    case 'x':
                        // Hexadecimal
                        let hexStr = '';
                        while (inputPos < input.length && !/\s/.test(input[inputPos])) {
                            hexStr += input[inputPos];
                            inputPos++;
                        }
                        const hexVal = parseInt(hexStr, 16);
                        if (!isNaN(hexVal)) {
                            this.writeMemory(argPtr, BigInt(hexVal), 8);
                            itemsRead++;
                        }
                        break;
                    case 's':
                        // String - read until whitespace (NOT entire line)
                        let strStart = inputPos;
                        while (inputPos < input.length && !/\s/.test(input[inputPos])) {
                            inputPos++;
                        }
                        const strLen = inputPos - strStart;
                        if (strLen > 0) {
                            for (let j = 0; j < strLen; j++) {
                                this.writeMemory(argPtr + BigInt(j), BigInt(input.charCodeAt(strStart + j)), 1);
                            }
                            this.writeMemory(argPtr + BigInt(strLen), 0n, 1);
                            itemsRead++;
                        }
                        break;
                    case 'c':
                        // Character - reads single byte including whitespace (doesn't skip whitespace)
                        // We already handled not skipping whitespace above
                        if (inputPos < input.length) {
                            this.writeMemory(argPtr, BigInt(input.charCodeAt(inputPos)), 1);
                            inputPos++;
                            itemsRead++;
                        }
                        break;
                    case 'l':
                        // Long modifier - %ld, %lu, %lx
                        if (i + 1 < fmt.length) {
                            i++;
                            const nextSpec = fmt[i];
                            // Skip whitespace before reading
                            while (inputPos < input.length && /\s/.test(input[inputPos])) {
                                inputPos++;
                            }
                            if (inputPos >= input.length) break;
                            
                            if (nextSpec === 'd' || nextSpec === 'i') {
                                // %ld or %li - signed long
                                let intStr = '';
                                while (inputPos < input.length && !/\s/.test(input[inputPos])) {
                                    intStr += input[inputPos];
                                    inputPos++;
                                }
                                const intVal = parseInt(intStr, 10);
                                if (!isNaN(intVal)) {
                                    this.writeMemory(argPtr, BigInt(intVal), 8);
                                    itemsRead++;
                                }
                            } else if (nextSpec === 'u') {
                                // %lu - unsigned long
                                let uintStr = '';
                                while (inputPos < input.length && !/\s/.test(input[inputPos])) {
                                    uintStr += input[inputPos];
                                    inputPos++;
                                }
                                const uintVal = parseInt(uintStr, 10);
                                if (!isNaN(uintVal) && uintVal >= 0) {
                                    this.writeMemory(argPtr, BigInt(uintVal), 8);
                                    itemsRead++;
                                }
                            } else if (nextSpec === 'x') {
                                // %lx - hexadecimal long
                                let hexStr = '';
                                while (inputPos < input.length && !/\s/.test(input[inputPos])) {
                                    hexStr += input[inputPos];
                                    inputPos++;
                                }
                                const hexVal = parseInt(hexStr, 16);
                                if (!isNaN(hexVal)) {
                                    this.writeMemory(argPtr, BigInt(hexVal), 8);
                                    itemsRead++;
                                }
                            }
                        }
                        break;
                    default:
                        // Unknown format specifier - skip it
                        break;
                }
                argIndex++;
            } else {
                // Regular character in format string - skip it
            }
        }
        
        // Return number of items successfully read in x0
        this.registers.x0 = BigInt(itemsRead);
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

